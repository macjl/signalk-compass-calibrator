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
      const detectedContext = await provider.detectContextFromPath('navigation.magneticVariation', range, body.resolutionSeconds || 30).catch(() => null)
      if (detectedContext) provider = provider.withContext(detectedContext)
      const result = await provider.discover(paths, range, body.resolutionSeconds || 30)
      const diagnostics = await Promise.all(paths.map(path => provider.diagnosePath(path, range, body.resolutionSeconds || 30)))
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
      const resolutionSeconds = body.resolutionSeconds || 1
      const series = await fetchCalibrationSeries(provider, sources, range, resolutionSeconds, filters)
      const profile = calibrate(series, {
        id: body.id,
        range,
        sources,
        filters,
        calibration: { ...options.calibration, ...(body.calibration || {}) }
      })
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

  async function fetchCalibrationSeries (provider, sources, range, resolutionSeconds, filters = {}) {
    const segments = await findUsefulSegments(provider, sources, range, resolutionSeconds, filters)
    const heading = []
    const cog = []
    const sog = []
    const variation = []

    for (const segment of segments) {
      const [segmentHeading, segmentCog, segmentSog, segmentVariation] = await Promise.all([
        provider.getSeriesChunked('navigation.headingMagnetic', sources.heading, segment, resolutionSeconds),
        provider.getSeriesChunked('navigation.courseOverGroundTrue', sources.cog, segment, resolutionSeconds),
        provider.getSeriesChunked('navigation.speedOverGround', sources.sog, segment, resolutionSeconds),
        provider.getSeriesChunked('navigation.magneticVariation', sources.variation, segment, resolutionSeconds)
      ])
      heading.push(...segmentHeading)
      cog.push(...segmentCog)
      sog.push(...segmentSog)
      variation.push(...segmentVariation)
    }

    return {
      heading: dedupeSamples(heading),
      cog: dedupeSamples(cog),
      sog: dedupeSamples(sog),
      variation: dedupeSamples(variation)
    }
  }

  async function findUsefulSegments (provider, sources, range, resolutionSeconds, filters = {}) {
    const from = new Date(range.from).getTime()
    const to = new Date(range.to).getTime()
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw httpError(400, 'Invalid calibration range')

    const durationSeconds = Math.max((to - from) / 1000, 1)
    const coarseResolution = Math.max(30, resolutionSeconds * 30, Math.ceil(durationSeconds / 3000))
    const minSog = Number(filters.minSog || DEFAULT_OPTIONS.filters.minSog)
    const minSegmentDuration = Number(filters.minSegmentDuration || DEFAULT_OPTIONS.filters.minSegmentDuration)
    const coarseSog = await provider.getSeriesChunked('navigation.speedOverGround', sources.sog, range, coarseResolution, 10000)
    if (coarseSog.length === 0) return [range]

    const paddingMs = coarseResolution * 2000
    const segments = []
    let start = null
    let last = null
    for (const sample of coarseSog) {
      if (sample.value >= minSog) {
        if (start === null) start = sample.t
        last = sample.t
      } else if (start !== null) {
        addSegment(segments, start, last, from, to, paddingMs, minSegmentDuration)
        start = null
        last = null
      }
    }
    if (start !== null) addSegment(segments, start, last, from, to, paddingMs, minSegmentDuration)

    return mergeSegments(segments, coarseResolution * 2000)
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

function dedupeSamples (samples) {
  const byTime = new Map()
  for (const sample of samples) byTime.set(sample.t, sample)
  return Array.from(byTime.values()).sort((a, b) => a.t - b.t)
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
    const cogRates = []
    for (let index = 1; index < cog.length; index += 1) {
      const dt = (cog[index].t - cog[index - 1].t) / 1000
      if (dt <= 0) continue
      cogRates.push(Math.abs(wrap180Deg(radToDeg(cog[index].value - cog[index - 1].value))) / dt)
    }
    const usefulRates = cogRates.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
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
    calibration,
    resolutionSeconds: durationSeconds > 7 * 86400 ? 2 : 1
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
