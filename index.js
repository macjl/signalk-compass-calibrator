'use strict'

const fs = require('fs')
const path = require('path')
const { calibrate, compileCalibrationProfile, correctionForCompiledProfile } = require('./lib/calibration')
const { wrap360Rad, radToDeg } = require('./lib/angles')
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
    maxRateOfTurn: 0.5,
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
      const provider = makeProvider(body)
      const range = body.range || { from: body.from, to: body.to }
      const paths = body.paths || [
        'navigation.headingMagnetic',
        'navigation.courseOverGroundTrue',
        'navigation.speedOverGround',
        'navigation.magneticVariation',
        'navigation.rateOfTurn'
      ]
      const contexts = await provider.labelValues('context').catch(() => [])
      const result = await provider.discover(paths, range, body.resolutionSeconds || 30)
      return {
        contexts,
        selectedContext: provider.context,
        paths: result
      }
    }))

    router.post('/api/calibrate', asyncRoute(async req => {
      const body = await readBody(req)
      const provider = makeProvider(body)
      const range = body.range || { from: body.from, to: body.to }
      const sources = { ...options.sources, ...(body.sources || {}) }
      assertSources(sources)
      const resolutionSeconds = body.resolutionSeconds || 1
      const series = await fetchCalibrationSeries(provider, sources, range, resolutionSeconds)
      const profile = calibrate(series, {
        id: body.id,
        range,
        sources,
        filters: { ...options.filters, ...(body.filters || {}) },
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

  function fetchCalibrationSeries (provider, sources, range, resolutionSeconds) {
    return Promise.all([
      provider.getSeries('navigation.headingMagnetic', sources.heading, range, resolutionSeconds),
      provider.getSeries('navigation.courseOverGroundTrue', sources.cog, range, resolutionSeconds),
      provider.getSeries('navigation.speedOverGround', sources.sog, range, resolutionSeconds),
      provider.getSeries('navigation.magneticVariation', sources.variation, range, resolutionSeconds),
      sources.rateOfTurn
        ? provider.getSeries('navigation.rateOfTurn', sources.rateOfTurn, range, resolutionSeconds).catch(() => [])
        : Promise.resolve([])
    ]).then(([heading, cog, sog, variation, rateOfTurn]) => ({ heading, cog, sog, variation, rateOfTurn }))
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
          variation: { type: 'string', title: 'Magnetic variation source' },
          rateOfTurn: { type: 'string', title: 'Rate of turn source' }
        }
      },
      filters: {
        type: 'object',
        title: 'Calibration filters',
        properties: {
          minSog: { type: 'number', title: 'Minimum SOG (m/s)', default: 1.5 },
          maxRateOfTurn: { type: 'number', title: 'Maximum rate of turn (deg/s)', default: 0.5 },
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
