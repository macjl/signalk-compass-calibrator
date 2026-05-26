'use strict'

const fs = require('fs')
const path = require('path')
const { calibrate, compileCalibrationProfile, correctionForCompiledProfile } = require('./lib/calibration')
const { wrap360Rad, wrap180Deg, radToDeg } = require('./lib/angles')
const { DEFAULT_METRICS, PrometheusHistoryProvider } = require('./lib/prometheus-history-provider')
const { createProfileStore } = require('./lib/profile-store')

const PLUGIN_ID = 'compass-calibrator'
const PUBLISH_SOURCE = 'signalk-compass-calibrator'
const PUBLISH_PATH = 'navigation.headingMagnetic'
const DISCOVERY_RESOLUTION_SECONDS = 30
const FINE_CALIBRATION_RESOLUTION_SECONDS = 1
const MAX_COARSE_SCAN_RESOLUTION_SECONDS = 60
const SEGMENT_BOUNDARY_PADDING_SECONDS = 60
const STABLE_COG_WINDOW_SECONDS = 15
const STABLE_COG_MIN_DURATION_SECONDS = 30
const STABLE_COG_MERGE_GAP_SECONDS = 5
const HEADING_COVERAGE_BIN_DEG = 10

const DEFAULT_OPTIONS = {
  enabled: true,
  prometheus: {
    baseUrl: 'http://victoriametrics:8428',
    type: 'victoriametrics',
    auth: {
      type: 'basic',
      username: '',
      password: ''
    }
  },
  context: 'vessels.self',
  metrics: DEFAULT_METRICS,
  sources: {
    heading: '',
    cog: '',
    sog: '',
    variation: ''
  },
  filters: {
    minSog: 1.5,
    maxCogRate: 1,
    maxSampleGapSeconds: 2,
    minSegmentDuration: 30,
    minSamplesPerBin: 10
  },
  calibration: {
    binSize: 10,
    smoothing: true,
    interpolation: 'linear-circular'
  },
  publishing: {
    enabled: true,
    source: PUBLISH_SOURCE,
    path: PUBLISH_PATH,
    staleAfterSeconds: 10
  }
}

module.exports = function createPlugin (app) {
  let options = { ...DEFAULT_OPTIONS }
  let store
  let unsubscribes = []
  let deltaListener = null
  let activeProfile = null
  let activeRuntimeProfile = null
  let staleTimer = null
  let lastPluginStatus = null
  const liveSources = new Map()
  const runtime = {
    status: 'inactive',
    activeProfileId: null,
    inputSource: null,
    lastRawHeading: null,
    lastCorrection: null,
    lastCalibratedHeading: null,
    lastInputAt: null,
    lastPublishedAt: null,
    warnings: []
  }

  const plugin = {
    id: PLUGIN_ID,
    name: 'Compass Calibrator',
    description: 'Calibrate a selected magnetic heading source using source-aware historical COG/SOG/variation data.',
    schema: buildSchema,
    start,
    stop,
    registerWithRouter
  }

  return plugin

  function start (pluginOptions) {
    options = mergeOptions(DEFAULT_OPTIONS, pluginOptions || {})
    store = createProfileStore(app, PLUGIN_ID)
    store.load()
    setActiveProfile(store.active())
    runtime.status = statusFromState()

    if (options.enabled && options.publishing.enabled) {
      subscribeToHeading()
      staleTimer = setInterval(checkStaleInput, 1000)
    }
    setPluginStatus()
  }

  function stop () {
    for (const unsubscribe of unsubscribes) {
      try {
        if (typeof unsubscribe === 'function') unsubscribe()
      } catch (error) {
        app.debug && app.debug(`Compass calibrator unsubscribe failed: ${error.message}`)
      }
    }
    unsubscribes = []
    if (deltaListener && typeof app.removeListener === 'function') {
      app.removeListener('delta', deltaListener)
    }
    deltaListener = null
    if (staleTimer) clearInterval(staleTimer)
    staleTimer = null
    runtime.status = 'inactive'
    activeRuntimeProfile = null
    setPluginStatus()
  }

  function subscribeToHeading () {
    const subscription = {
      context: options.context || 'vessels.self',
      subscribe: [
        {
          path: PUBLISH_PATH,
          period: 500
        }
      ]
    }

    if (app.subscriptionmanager && typeof app.subscriptionmanager.subscribe === 'function') {
      app.subscriptionmanager.subscribe(
        subscription,
        unsubscribes,
        error => {
          runtime.status = 'error'
          app.error && app.error(`Compass calibrator subscription failed: ${error.message || error}`)
        },
        handleDelta
      )
      return
    }

    if (typeof app.on === 'function') {
      deltaListener = handleDelta
      app.on('delta', deltaListener)
    }
  }

  function handleDelta (delta) {
    for (const update of delta.updates || []) {
      const source = update.$source || update.source && update.source.label
      if (!source || source === options.publishing.source) continue
      if (!activeRuntimeProfile) recordLiveSource(source, update.values || [])

      const configuredSource = getRuntimeInputSource()
      if (!configuredSource || source !== configuredSource) continue

      const headingValue = (update.values || []).find(value => value.path === PUBLISH_PATH)
      if (!headingValue || !Number.isFinite(headingValue.value)) continue

      runtime.lastInputAt = new Date().toISOString()
      runtime.inputSource = source
      runtime.lastRawHeading = headingValue.value
      publishCorrectedHeading(source, headingValue.value)
    }
  }

  function publishCorrectedHeading (source, rawHeadingRad) {
    if (!activeRuntimeProfile && store) setActiveProfile(store.active())
    if (!activeRuntimeProfile) {
      runtime.status = 'noProfile'
      return
    }

    const correctionRad = correctionForCompiledProfile(activeRuntimeProfile, rawHeadingRad)
    if (!Number.isFinite(correctionRad)) {
      runtime.status = 'outsideReliableRange'
      return
    }

    const calibrated = wrap360Rad(rawHeadingRad + correctionRad)
    runtime.status = 'publishing'
    runtime.activeProfileId = activeRuntimeProfile.id
    runtime.lastCorrection = correctionRad
    runtime.lastCalibratedHeading = calibrated
    runtime.lastPublishedAt = new Date().toISOString()

    app.handleMessage(PLUGIN_ID, {
      updates: [
        {
          $source: options.publishing.source,
          values: [
            { path: options.publishing.path, value: calibrated }
          ]
        }
      ]
    })
    setPluginStatus()
  }

  function checkStaleInput () {
    if (!runtime.lastInputAt) {
      runtime.status = activeProfile ? 'missingInput' : 'noProfile'
      setPluginStatus()
      return
    }
    const ageSeconds = (Date.now() - new Date(runtime.lastInputAt).getTime()) / 1000
    if (ageSeconds > options.publishing.staleAfterSeconds) {
      runtime.status = 'staleInput'
      setPluginStatus()
    }
  }

  function registerWithRouter (router) {
    router.get('/', (req, res) => sendPublicFile(res, 'index.html', 'text/html; charset=utf-8'))
    router.get('/app.js', (req, res) => sendPublicFile(res, 'app.js', 'application/javascript; charset=utf-8'))
    router.get('/styles.css', (req, res) => sendPublicFile(res, 'styles.css', 'text/css; charset=utf-8'))

    router.get('/api/sources', asyncRoute(async () => ({
      live: Array.from(liveSources.values()),
      selected: options.sources,
      context: options.context,
      prometheus: {
        baseUrl: options.prometheus.baseUrl,
        type: options.prometheus.type,
        auth: {
          type: options.prometheus.auth && options.prometheus.auth.type || 'basic',
          username: options.prometheus.auth && options.prometheus.auth.username || ''
        }
      },
      metrics: options.metrics
    })))

    router.post('/api/discover', asyncRoute(async req => {
      const body = await readBody(req)
      let provider = makeProvider(body)
      const range = body.range || { from: body.from, to: body.to }
      const paths = body.paths || [
        'navigation.headingMagnetic',
        'navigation.courseOverGroundTrue',
        'navigation.speedOverGround',
        'navigation.magneticVariation'
      ]
      const detectedContext = await provider.detectContextFromPath('navigation.magneticVariation', range, body.resolutionSeconds || DISCOVERY_RESOLUTION_SECONDS).catch(() => null)
      if (detectedContext) provider = provider.withContext(detectedContext)
      const result = await provider.discover(paths, range, body.resolutionSeconds || DISCOVERY_RESOLUTION_SECONDS)
      const diagnostics = await Promise.all(paths.map(path => provider.diagnosePath(path, range, body.resolutionSeconds || DISCOVERY_RESOLUTION_SECONDS)))
      const recommendations = await buildRecommendations(provider, result, range).catch(error => ({ error: error.message }))
      return {
        detectedContext,
        selectedContext: provider.context,
        paths: result,
        diagnostics,
        recommendations
      }
    }))

    router.post('/api/calibrate', asyncRoute(async req => {
      const body = await readBody(req)
      const provider = makeProvider(body)
      const range = body.range || { from: body.from, to: body.to }
      const sources = { ...options.sources, ...(body.sources || {}) }
      assertSources(sources)
      const filters = { ...options.filters, ...(body.filters || {}) }
      const { series, segments } = await fetchCalibrationSeries(provider, sources, range, filters)
      filters.segments = calibrationSegmentsFromNavigationSegments(segments)
        .filter(segment => segment.quality !== 'rejected')
        .map(segment => ({
          from: segment.from,
          to: segment.to,
          minSog: segment.minSog,
          maxCogRate: segment.maxCogRate,
          quality: segment.quality,
          reason: segment.reason || null
        }))
      const profile = calibrate(series, {
        id: body.id,
        range,
        sources,
        filters,
        calibration: { ...options.calibration, ...(body.calibration || {}) }
      })
      profile.segments = segments
      store.upsert(profile)
      return profile
    }))

    router.get('/api/profiles', asyncRoute(async () => ({
      activeProfileId: store.active() ? store.active().id : null,
      profiles: store.list().map(profileSummary)
    })))

    router.get('/api/profiles/:id', asyncRoute(async req => {
      const profile = store.get(req.params.id)
      if (!profile) throw httpError(404, 'Profile not found')
      return profile
    }))

    router.post('/api/profiles/:id/activate', asyncRoute(async req => {
      const candidate = store.get(req.params.id)
      if (!candidate) throw httpError(404, 'Profile not found')
      if (!compileCalibrationProfile(candidate)) throw httpError(400, 'Profile has no usable runtime correction table')
      const profile = store.activate(req.params.id)
      setActiveProfile(profile)
      runtime.status = statusFromState()
      setPluginStatus()
      return profile
    }))

    router.post('/api/profiles/:id/archive', asyncRoute(async req => {
      const profile = store.archive(req.params.id)
      if (!profile) throw httpError(404, 'Profile not found')
      if (activeProfile && activeProfile.id === req.params.id) setActiveProfile(null)
      runtime.status = statusFromState()
      setPluginStatus()
      return profile
    }))

    router.post('/api/profiles/:id/reject', asyncRoute(async req => {
      const profile = store.reject(req.params.id)
      if (!profile) throw httpError(404, 'Profile not found')
      if (activeProfile && activeProfile.id === req.params.id) setActiveProfile(null)
      runtime.status = statusFromState()
      setPluginStatus()
      return profile
    }))

    router.delete('/api/profiles/:id', asyncRoute(async req => {
      const deleted = store.delete(req.params.id)
      if (!deleted) throw httpError(404, 'Profile not found')
      if (activeProfile && activeProfile.id === req.params.id) setActiveProfile(null)
      runtime.status = statusFromState()
      setPluginStatus()
      return { deleted: true }
    }))

    router.get('/api/runtime', asyncRoute(async () => ({
      ...runtime,
      activeProfile: activeProfile ? profileSummary(activeProfile) : null,
      lastRawHeadingDeg: runtime.lastRawHeading === null ? null : radToDeg(runtime.lastRawHeading),
      lastCorrectionDeg: runtime.lastCorrection === null ? null : radToDeg(runtime.lastCorrection),
      lastCalibratedHeadingDeg: runtime.lastCalibratedHeading === null ? null : radToDeg(runtime.lastCalibratedHeading)
    })))
  }

  function makeProvider (body = {}) {
    return new PrometheusHistoryProvider({
      baseUrl: body.baseUrl || body.prometheus && body.prometheus.baseUrl || options.prometheus.baseUrl,
      context: body.context || options.context,
      metrics: { ...options.metrics, ...(body.metrics || {}) },
      auth: body.auth || body.prometheus && body.prometheus.auth || options.prometheus.auth
    })
  }

  async function fetchCalibrationSeries (provider, sources, range, filters = {}) {
    const coarseSegments = await findUsefulSegments(provider, sources, range, filters)
    const segments = []
    const heading = []
    const cog = []
    const sog = []
    const variation = []

    for (const segment of coarseSegments) {
      if (segment.quality === 'rejected') {
        segments.push(segment)
        continue
      }
      const [segmentHeading, segmentCog, segmentSog, segmentVariation] = await Promise.all([
        provider.getSeriesChunked('navigation.headingMagnetic', sources.heading, segment, FINE_CALIBRATION_RESOLUTION_SECONDS),
        provider.getSeriesChunked('navigation.courseOverGroundTrue', sources.cog, segment, FINE_CALIBRATION_RESOLUTION_SECONDS),
        provider.getSeriesChunked('navigation.speedOverGround', sources.sog, segment, FINE_CALIBRATION_RESOLUTION_SECONDS),
        provider.getSeriesChunked('navigation.magneticVariation', sources.variation, segment, FINE_CALIBRATION_RESOLUTION_SECONDS)
      ])
      const navigationSegment = analyzeSegmentSamples(segment, segmentSog, segmentCog, filters, FINE_CALIBRATION_RESOLUTION_SECONDS, 'fine')
      navigationSegment.stableSegments = buildStableCogSegments(navigationSegment, segmentSog, segmentCog, segmentHeading, filters)
      navigationSegment.headingBins = mergeHeadingBins(navigationSegment.stableSegments.map(stable => stable.headingBins))
      navigationSegment.quality = navigationSegment.stableSegments.length > 0
        ? navigationSegment.quality
        : 'rejected'
      navigationSegment.reason = navigationSegment.stableSegments.length > 0
        ? navigationSegment.reason
        : 'no stable COG sub-segment found'
      navigationSegment.stats.stableSegmentCount = navigationSegment.stableSegments.length
      navigationSegment.stats.acceptedSamples = navigationSegment.stableSegments.reduce((sum, stable) => sum + Number(stable.stats && stable.stats.samples && stable.stats.samples.heading || 0), 0)
      segments.push(navigationSegment)
      for (const stableSegment of navigationSegment.stableSegments) {
        heading.push(...samplesInRange(segmentHeading, stableSegment))
        cog.push(...samplesInRange(segmentCog, stableSegment))
        sog.push(...samplesInRange(segmentSog, stableSegment))
        variation.push(...samplesInRange(segmentVariation, stableSegment))
      }
    }

    return {
      series: {
        heading: dedupeSamples(heading),
        cog: dedupeSamples(cog),
        sog: dedupeSamples(sog),
        variation: dedupeSamples(variation)
      },
      segments
    }
  }

  async function findUsefulSegments (provider, sources, range, filters = {}) {
    const from = new Date(range.from).getTime()
    const to = new Date(range.to).getTime()
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw httpError(400, 'Invalid calibration range')

    const durationSeconds = Math.max((to - from) / 1000, 1)
    const coarseResolution = Math.max(DISCOVERY_RESOLUTION_SECONDS, Math.min(MAX_COARSE_SCAN_RESOLUTION_SECONDS, Math.ceil(durationSeconds / 3000)))
    const minSog = Number(filters.minSog || DEFAULT_OPTIONS.filters.minSog)
    const movementDetectionSog = Math.max(0.3, Math.min(minSog, 0.8))
    const minSegmentDuration = Number(filters.minSegmentDuration || DEFAULT_OPTIONS.filters.minSegmentDuration)
    const coarseSog = await provider.getSeriesChunked('navigation.speedOverGround', sources.sog, range, coarseResolution, 10000)
    if (coarseSog.length === 0) return [analyzeSegmentSamples(range, [], [], filters, coarseResolution, 'coarse')]

    const paddingMs = coarseResolution * 2000
    const segments = []
    let start = null
    let last = null
    for (const sample of coarseSog) {
      if (sample.value >= movementDetectionSog) {
        if (start === null) start = sample.t
        last = sample.t
      } else if (start !== null) {
        addSegment(segments, start, last, from, to, paddingMs, minSegmentDuration)
        start = null
        last = null
      }
    }
    if (start !== null) addSegment(segments, start, last, from, to, paddingMs, minSegmentDuration)
    if (segments.length === 0) {
      return [{
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        quality: 'rejected',
        reason: 'no SOG movement found',
        stats: {
          durationSeconds: Math.round(durationSeconds),
          analysisPass: 'coarse',
          analysisResolutionSeconds: coarseResolution,
          samples: {
            sog: coarseSog.length,
            cog: 0
          }
        }
      }]
    }

    const merged = mergeSegments(segments, coarseResolution * 2000)
    const refined = []
    for (const segment of merged) {
      refined.push(await refineSegmentBoundaries(provider, sources, segment, range, movementDetectionSog, minSegmentDuration))
    }
    return refined
  }

  async function refineSegmentBoundaries (provider, sources, segment, fullRange, movementDetectionSog, minSegmentDuration) {
    const samples = await provider.getSeriesChunked(
      'navigation.speedOverGround',
      sources.sog,
      segment,
      FINE_CALIBRATION_RESOLUTION_SECONDS,
      10000
    ).catch(() => [])
    const moving = samples.filter(sample => Number.isFinite(sample.value) && sample.value >= movementDetectionSog)
    if (moving.length === 0) {
      return {
        ...segment,
        coarseFrom: segment.from,
        coarseTo: segment.to,
        quality: 'rejected',
        reason: 'no fine SOG movement found',
        stats: { samples: { sog: samples.length, cog: 0 } }
      }
    }

    const rangeFrom = new Date(fullRange.from).getTime()
    const rangeTo = new Date(fullRange.to).getTime()
    const movementFrom = moving[0].t
    const movementTo = moving[moving.length - 1].t
    const paddingMs = SEGMENT_BOUNDARY_PADDING_SECONDS * 1000
    const refinedFrom = Math.max(rangeFrom, movementFrom - paddingMs)
    const refinedTo = Math.min(rangeTo, movementTo + paddingMs)
    const durationSeconds = (refinedTo - refinedFrom) / 1000

    return {
      ...segment,
      coarseFrom: segment.from,
      coarseTo: segment.to,
      movementFrom: new Date(movementFrom).toISOString(),
      movementTo: new Date(movementTo).toISOString(),
      from: new Date(refinedFrom).toISOString(),
      to: new Date(refinedTo).toISOString(),
      boundaryResolutionSeconds: FINE_CALIBRATION_RESOLUTION_SECONDS,
      boundaryPaddingSeconds: SEGMENT_BOUNDARY_PADDING_SECONDS,
      quality: durationSeconds < minSegmentDuration ? 'rejected' : 'candidate',
      reason: durationSeconds < minSegmentDuration ? 'too short after boundary refinement' : null,
      stats: {
        durationSeconds: Math.round(durationSeconds),
        samples: {
          sog: samples.length,
          cog: 0
        }
      }
    }
  }

  function analyzeSegmentSamples (segment, sog, cog, filters = {}, resolutionSeconds = 1, pass = 'fine') {
    const speeds = sog.map(sample => sample.value).filter(value => Number.isFinite(value)).sort((a, b) => a - b)
    const cogRates = cogRatesDegPerSecond(cog).sort((a, b) => a - b)
    const minSog = round1(clamp(percentile(speeds.filter(value => value > 0.2), pass === 'fine' ? 0.20 : 0.25) || filters.minSog || DEFAULT_OPTIONS.filters.minSog, 0.8, 3))
    const localCogRate = round1(clamp(percentile(cogRates, pass === 'fine' ? 0.90 : 0.75) || filters.maxCogRate || DEFAULT_OPTIONS.filters.maxCogRate, 0.5, 6))
    const medianCogRate = percentile(cogRates, 0.50) || 0
    const p90CogRate = percentile(cogRates, 0.90) || 0
    const durationSeconds = (new Date(segment.to).getTime() - new Date(segment.from).getTime()) / 1000
    const quality = durationSeconds < Number(filters.minSegmentDuration || DEFAULT_OPTIONS.filters.minSegmentDuration) || speeds.length < 3 || cog.length < 3
      ? 'rejected'
      : p90CogRate > 4
        ? 'weak'
        : 'good'

    return {
      ...segment,
      minSog,
      maxCogRate: localCogRate,
      quality,
      reason: quality === 'rejected'
        ? 'too short or sparse'
        : p90CogRate > localCogRate
          ? 'high course variation; filtering at local threshold'
          : null,
      stats: {
        durationSeconds: Math.round(durationSeconds),
        analysisPass: pass,
        analysisResolutionSeconds: Number(resolutionSeconds),
        sogMedian: round1(percentile(speeds, 0.50) || 0),
        cogRateMedian: round1(medianCogRate),
        cogRateP90: round1(p90CogRate),
        samples: {
          sog: sog.length,
          cog: cog.length
        }
      }
    }
  }

  function buildStableCogSegments (navigationSegment, sog, cog, heading, filters = {}) {
    const minSog = Number(navigationSegment.minSog || filters.minSog || DEFAULT_OPTIONS.filters.minSog)
    const threshold = stableCogRateThreshold(cog)
    const sogByTime = new Map(sog.map(sample => [sample.t, sample.value]))
    const states = []
    const rateWindow = []
    let windowSum = 0

    const sortedCog = dedupeSamples(cog).sort((a, b) => a.t - b.t)
    for (let index = 1; index < sortedCog.length; index += 1) {
      const previous = sortedCog[index - 1]
      const current = sortedCog[index]
      const dt = (current.t - previous.t) / 1000
      if (dt <= 0) continue
      const rate = Math.abs(wrap180Deg(radToDeg(current.value - previous.value))) / dt
      if (!Number.isFinite(rate)) continue
      rateWindow.push({ t: current.t, rate })
      windowSum += rate
      while (rateWindow.length && current.t - rateWindow[0].t > STABLE_COG_WINDOW_SECONDS * 1000) {
        windowSum -= rateWindow.shift().rate
      }
      const smoothedRate = rateWindow.length ? windowSum / rateWindow.length : rate
      const speed = sogByTime.get(current.t)
      states.push({
        from: previous.t,
        to: current.t,
        stable: Number.isFinite(speed) && speed >= minSog && smoothedRate <= threshold,
        smoothedRate
      })
    }

    const rawSegments = segmentsFromStates(states, STABLE_COG_MIN_DURATION_SECONDS)
    const merged = mergeSegments(
      rawSegments.map(segment => ({
        from: new Date(segment.from).toISOString(),
        to: new Date(segment.to).toISOString()
      })),
      STABLE_COG_MERGE_GAP_SECONDS * 1000
    )

    return merged.map((segment, index) => {
      const stableSog = samplesInRange(sog, segment)
      const stableCog = samplesInRange(cog, segment)
      const stableHeading = samplesInRange(heading, segment)
      const analyzed = analyzeSegmentSamples(segment, stableSog, stableCog, {
        ...filters,
        minSog,
        maxCogRate: threshold
      }, FINE_CALIBRATION_RESOLUTION_SECONDS, 'stable')
      const maxCogRate = round1(clamp(threshold * 1.2, 0.5, 2.5))
      return {
        ...analyzed,
        id: `${navigationSegment.from}-${index + 1}`,
        parentFrom: navigationSegment.from,
        parentTo: navigationSegment.to,
        maxCogRate,
        stableCogThreshold: round1(threshold),
        stableWindowSeconds: STABLE_COG_WINDOW_SECONDS,
        headingBins: headingBinCounts(stableHeading, HEADING_COVERAGE_BIN_DEG),
        stats: {
          ...analyzed.stats,
          samples: {
            ...analyzed.stats.samples,
            heading: stableHeading.length
          }
        }
      }
    }).filter(segment => segment.quality !== 'rejected')
  }

  function assertSources (sources) {
    for (const key of ['heading', 'cog', 'sog', 'variation']) {
      if (!sources[key]) throw httpError(400, `Missing ${key} source`)
    }
  }

  function getRuntimeInputSource () {
    return options.sources.heading || activeRuntimeProfile && activeRuntimeProfile.source || activeProfile && activeProfile.sources && activeProfile.sources.heading
  }

  function setActiveProfile (profile) {
    activeProfile = profile || null
    activeRuntimeProfile = activeProfile ? compileCalibrationProfile(activeProfile) : null
    runtime.activeProfileId = activeRuntimeProfile ? activeRuntimeProfile.id : null
    runtime.inputSource = getRuntimeInputSource()
  }

  function recordLiveSource (source, values) {
    const current = liveSources.get(source) || {
      source,
      paths: {},
      firstSeen: new Date().toISOString()
    }
    current.lastSeen = new Date().toISOString()
    for (const value of values) {
      current.paths[value.path] = {
        latestValue: value.value,
        lastSeen: current.lastSeen
      }
    }
    liveSources.set(source, current)
  }

  function statusFromState () {
    if (!options.enabled || !options.publishing.enabled) return 'inactive'
    if (!activeRuntimeProfile) return 'noProfile'
    if (!getRuntimeInputSource()) return 'missingInput'
    return 'active'
  }

  function setPluginStatus () {
    if (typeof app.setPluginStatus === 'function') {
      const statusText = `Compass calibrator: ${runtime.status}`
      if (statusText !== lastPluginStatus) {
        app.setPluginStatus(statusText)
        lastPluginStatus = statusText
      }
    }
  }
}

function buildSchema () {
  return {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', title: 'Enable plugin', default: true },
      prometheus: {
        type: 'object',
        title: 'Prometheus compatible history backend',
        properties: {
          baseUrl: { type: 'string', title: 'Base URL', default: DEFAULT_OPTIONS.prometheus.baseUrl },
          type: { type: 'string', title: 'Backend type', default: 'victoriametrics' },
          auth: {
            type: 'object',
            title: 'Authentication',
            properties: {
              type: { type: 'string', title: 'Type', default: 'basic', enum: ['basic'] },
              username: { type: 'string', title: 'Username' },
              password: { type: 'string', title: 'Password' }
            }
          }
        }
      },
      context: { type: 'string', title: 'Signal K context', default: 'vessels.self' },
      metrics: {
        type: 'object',
        title: 'Metric names',
        properties: Object.fromEntries(Object.entries(DEFAULT_METRICS).map(([key, value]) => [
          key,
          { type: 'string', default: value }
        ]))
      },
      sources: {
        type: 'object',
        title: 'Input sources',
        properties: {
          heading: { type: 'string', title: 'Raw heading source' },
          cog: { type: 'string', title: 'COG source' },
          sog: { type: 'string', title: 'SOG source' },
          variation: { type: 'string', title: 'Magnetic variation source' }
        }
      },
      filters: {
        type: 'object',
        title: 'Calibration filters',
        properties: {
          minSog: { type: 'number', title: 'Minimum SOG (m/s)', default: 1.5 },
          maxCogRate: { type: 'number', title: 'Maximum COG rate (deg/s)', default: 1 },
          maxSampleGapSeconds: { type: 'number', title: 'Maximum sample gap (s)', default: 2 },
          minSegmentDuration: { type: 'number', title: 'Minimum segment duration (s)', default: 30 },
          minSamplesPerBin: { type: 'number', title: 'Minimum samples per bin', default: 10 }
        }
      },
      calibration: {
        type: 'object',
        title: 'Calibration',
        properties: {
          binSize: { type: 'number', title: 'Bin size (deg)', default: 10, enum: [5, 10, 15, 30] },
          smoothing: { type: 'boolean', title: 'Smoothing', default: true },
          interpolation: { type: 'string', title: 'Interpolation', default: 'linear-circular' }
        }
      },
      publishing: {
        type: 'object',
        title: 'Publishing',
        properties: {
          enabled: { type: 'boolean', title: 'Publish corrected heading', default: true },
          source: { type: 'string', title: 'Publish source', default: PUBLISH_SOURCE },
          path: { type: 'string', title: 'Publish path', default: PUBLISH_PATH },
          staleAfterSeconds: { type: 'number', title: 'Input stale after (s)', default: 10 }
        }
      }
    }
  }
}

function asyncRoute (handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res))
      .then(payload => sendJson(res, payload))
      .catch(error => sendJson(res, { error: error.message || String(error) }, error.statusCode || 500))
  }
}

function sendJson (res, payload, statusCode = 200) {
  res.statusCode = statusCode
  if (typeof res.setHeader === 'function') res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readBody (req) {
  if (req.body !== undefined) return Promise.resolve(req.body || {})
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(httpError(400, 'Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function sendPublicFile (res, filename, contentType) {
  const filePath = path.join(__dirname, 'public', filename)
  res.statusCode = 200
  if (typeof res.setHeader === 'function') res.setHeader('content-type', contentType)
  fs.createReadStream(filePath).on('error', () => {
    res.statusCode = 404
    res.end('Not found')
  }).pipe(res)
}

function httpError (statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function mergeOptions (base, override) {
  if (!override || typeof override !== 'object') return structuredCloneSafe(base)
  const result = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      result[key] = mergeOptions(base[key], value)
    } else {
      result[key] = value
    }
  }
  return result
}

function structuredCloneSafe (value) {
  return JSON.parse(JSON.stringify(value))
}

function addSegment (segments, start, end, rangeFrom, rangeTo, paddingMs, minDurationSeconds) {
  if (end - start < minDurationSeconds * 1000) return
  segments.push({
    from: new Date(Math.max(rangeFrom, start - paddingMs)).toISOString(),
    to: new Date(Math.min(rangeTo, end + paddingMs)).toISOString()
  })
}

function mergeSegments (segments, mergeGapMs) {
  const sorted = segments
    .map(segment => ({
      from: new Date(segment.from).getTime(),
      to: new Date(segment.to).getTime()
    }))
    .filter(segment => Number.isFinite(segment.from) && Number.isFinite(segment.to) && segment.to >= segment.from)
    .sort((a, b) => a.from - b.from)

  const merged = []
  for (const segment of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && segment.from - previous.to <= mergeGapMs) {
      previous.to = Math.max(previous.to, segment.to)
    } else {
      merged.push({ ...segment })
    }
  }

  return merged.map(segment => ({
    from: new Date(segment.from).toISOString(),
    to: new Date(segment.to).toISOString()
  }))
}

function segmentsFromStates (states, minDurationSeconds) {
  const segments = []
  let start = null
  let last = null
  for (const state of states) {
    if (state.stable) {
      if (start === null) start = state.from
      last = state.to
    } else if (start !== null) {
      if (last - start >= minDurationSeconds * 1000) segments.push({ from: start, to: last })
      start = null
      last = null
    }
  }
  if (start !== null && last - start >= minDurationSeconds * 1000) segments.push({ from: start, to: last })
  return segments
}

function dedupeSamples (samples) {
  const byTime = new Map()
  for (const sample of samples) byTime.set(sample.t, sample)
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t)
}

function cogRatesDegPerSecond (samples) {
  const rates = []
  const sorted = dedupeSamples(samples).sort((a, b) => a.t - b.t)
  for (let index = 1; index < sorted.length; index += 1) {
    const dt = (sorted[index].t - sorted[index - 1].t) / 1000
    if (dt <= 0) continue
    const rate = Math.abs(wrap180Deg(radToDeg(sorted[index].value - sorted[index - 1].value))) / dt
    if (Number.isFinite(rate) && rate > 0) rates.push(rate)
  }
  return rates
}

function stableCogRateThreshold (samples) {
  const rates = cogRatesDegPerSecond(samples).sort((a, b) => a - b)
  const median = percentile(rates, 0.50)
  if (!Number.isFinite(median)) return 1.5
  return clamp(median * 1.5, 0.5, 2)
}

function samplesInRange (samples, range) {
  const from = new Date(range.from).getTime()
  const to = new Date(range.to).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to)) return []
  return samples.filter(sample => sample.t >= from && sample.t <= to)
}

function headingBinCounts (headingSamples, binSizeDeg) {
  const binCount = Math.ceil(360 / binSizeDeg)
  const bins = Array.from({ length: binCount }, (_, index) => ({
    fromDeg: index * binSizeDeg,
    toDeg: Math.min((index + 1) * binSizeDeg, 360),
    samples: 0
  }))
  for (const sample of headingSamples) {
    if (!Number.isFinite(sample.value)) continue
    const headingDeg = radToDeg(wrap360Rad(sample.value))
    const index = Math.min(Math.floor(headingDeg / binSizeDeg), binCount - 1)
    bins[index].samples += 1
  }
  return bins
}

function mergeHeadingBins (binsList) {
  const merged = headingBinCounts([], HEADING_COVERAGE_BIN_DEG)
  for (const bins of binsList) {
    if (!Array.isArray(bins)) continue
    for (let index = 0; index < Math.min(merged.length, bins.length); index += 1) {
      merged[index].samples += Number(bins[index].samples || 0)
    }
  }
  return merged
}

function calibrationSegmentsFromNavigationSegments (segments) {
  const flat = []
  for (const segment of segments || []) {
    if (Array.isArray(segment.stableSegments) && segment.stableSegments.length > 0) {
      flat.push(...segment.stableSegments)
    } else {
      flat.push(segment)
    }
  }
  return flat
}

async function buildRecommendations (provider, discovered, range) {
  const sources = {
    heading: bestDiscoveredSource(discovered['navigation.headingMagnetic']),
    cog: bestDiscoveredSource(discovered['navigation.courseOverGroundTrue']),
    sog: bestDiscoveredSource(discovered['navigation.speedOverGround']),
    variation: bestDiscoveredSource(discovered['navigation.magneticVariation'])
  }
  const filters = {
    minSog: DEFAULT_OPTIONS.filters.minSog,
    maxCogRate: DEFAULT_OPTIONS.filters.maxCogRate,
    minSamplesPerBin: DEFAULT_OPTIONS.filters.minSamplesPerBin
  }
  const calibration = {
    binSize: DEFAULT_OPTIONS.calibration.binSize
  }

  const from = new Date(range.from).getTime()
  const to = new Date(range.to).getTime()
  const durationSeconds = Math.max((to - from) / 1000, 1)
  const coarseResolution = Math.max(30, Math.ceil(durationSeconds / 2500))
  let movingSampleCount = 0

  if (sources.sog) {
    const sog = await provider.getSeriesChunked('navigation.speedOverGround', sources.sog, range, coarseResolution, 10000)
    const speeds = sog.map(sample => sample.value).filter(value => Number.isFinite(value) && value > 0.2).sort((a, b) => a - b)
    movingSampleCount = speeds.length
    if (speeds.length > 0) {
      filters.minSog = round1(clamp(percentile(speeds, 0.35), 0.8, 3))
    }
  }

  if (sources.cog) {
    const cog = await provider.getSeriesChunked('navigation.courseOverGroundTrue', sources.cog, range, coarseResolution, 10000)
    const usefulRates = cogRatesDegPerSecond(cog).sort((a, b) => a - b)
    if (usefulRates.length > 0) {
      filters.maxCogRate = round1(clamp(percentile(usefulRates, 0.65), 0.5, 3))
    }
  }

  const headingSamples = discovered['navigation.headingMagnetic'] || []
  const totalHeadingSamples = headingSamples.reduce((sum, source) => sum + Number(source.sampleCount || 0), 0)
  const estimatedSamples = Math.max(totalHeadingSamples, movingSampleCount)
  if (estimatedSamples < 500) {
    calibration.binSize = 30
    filters.minSamplesPerBin = 5
  } else if (estimatedSamples < 1500) {
    calibration.binSize = 15
    filters.minSamplesPerBin = 8
  } else {
    calibration.binSize = 10
    filters.minSamplesPerBin = 10
  }

  return {
    sources,
    filters,
    calibration
  }
}

function bestDiscoveredSource (sources = []) {
  const best = [...sources].sort((a, b) => {
    const scoreA = Number(a.coveragePercent || 0) * 1000000 + Number(a.sampleCount || 0)
    const scoreB = Number(b.coveragePercent || 0) * 1000000 + Number(b.sampleCount || 0)
    return scoreB - scoreA
  })[0]
  return best ? best.source : ''
}

function percentile (sortedValues, fraction) {
  if (!sortedValues.length) return null
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * fraction)))
  return sortedValues[index]
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round1 (value) {
  return Math.round(value * 10) / 10
}

function profileSummary (profile) {
  return {
    id: profile.id,
    createdAt: profile.createdAt,
    state: profile.state,
    range: profile.range,
    sources: profile.sources,
    quality: profile.quality,
    warnings: profile.warnings || []
  }
}
