'use strict'

const fs = require('fs')
const path = require('path')
const { DEFAULT_OPTIONS, INPUT_PATHS, PUBLISH_PATH } = require('./lib/default-options')
const { createTableStore } = require('./lib/table-store')
const {
  normalizeTable,
  updateTableWithObservation,
  setManualCorrection,
  resetSector,
  setSectorLocked,
  correctionForHeadingRad,
  summarizeTable
} = require('./lib/correction-table')
const { wrap360Rad, wrap180Deg, radToDeg } = require('./lib/angles')
const { buildSchema } = require('./lib/plugin-schema')

const PLUGIN_ID = 'compass-calibrator'

module.exports = function createPlugin (app) {
  let options = mergeOptions(DEFAULT_OPTIONS, {})
  let store = null
  let table = null
  let unsubscribes = []
  let staleTimer = null
  let startedAt = 0
  let lastSaveAt = 0
  const inputs = new Map()
  const runtime = createRuntimeState()

  const plugin = {
    id: PLUGIN_ID,
    name: 'Compass Calibrator',
    description: 'Live heading correction learning for Signal K magnetic heading data.',
    schema: buildSchema,
    start,
    stop,
    registerWithRouter
  }

  return plugin

  function start (pluginOptions) {
    options = mergeOptions(DEFAULT_OPTIONS, pluginOptions || {})
    store = createTableStore(app, PLUGIN_ID, options.table)
    store.load()
    table = normalizeTable(store.table(), options.table)
    startedAt = Date.now()
    lastSaveAt = 0
    runtime.learningEnabled = store.learningEnabled()
    runtime.status = 'starting'
    subscribeToInputs()
    staleTimer = setInterval(checkStaleInput, 1000)
    setPluginStatus()
  }

  function stop () {
    if (store && table) store.setTable(table)
    for (const unsubscribe of unsubscribes) {
      try {
        if (typeof unsubscribe === 'function') unsubscribe()
      } catch (error) {
        app.debug && app.debug(`Compass calibrator unsubscribe failed: ${error.message}`)
      }
    }
    unsubscribes = []
    if (staleTimer) clearInterval(staleTimer)
    staleTimer = null
    runtime.status = 'stopped'
    setPluginStatus()
  }

  function subscribeToInputs () {
    const subscription = {
      context: options.context || 'vessels.self',
      excludeSelf: true,
      subscribe: [
        { path: INPUT_PATHS.heading, period: 500 },
        { path: INPUT_PATHS.cog, period: 500 },
        { path: INPUT_PATHS.sog, period: 500 },
        { path: INPUT_PATHS.variation, period: 1000 }
      ]
    }

    if (!app.subscriptionmanager || typeof app.subscriptionmanager.subscribe !== 'function') {
      runtime.status = 'error'
      runtime.lastRejectReason = 'Signal K subscription manager is not available'
      setPluginStatus()
      return
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      error => {
        runtime.status = 'error'
        runtime.lastRejectReason = error && error.message || String(error)
        setPluginStatus()
      },
      handleDelta
    )
  }

  function handleDelta (delta) {
    const now = Date.now()
    for (const update of delta.updates || []) {
      const source = sourceRef(update)
      const timestamp = normalizeTimestamp(update.timestamp) || now
      for (const item of update.values || []) {
        if (!isInputPath(item.path) || !Number.isFinite(item.value)) continue
        updateInput(item.path, item.value, source, timestamp)
        if (item.path === INPUT_PATHS.heading) publishCorrectedHeading(item.value, source, timestamp)
      }
    }
    if (runtime.learningEnabled) learnFromCurrentInputs(now)
  }

  function updateInput (inputPath, value, source, timestamp) {
    const previous = inputs.get(inputPath) || null
    inputs.set(inputPath, {
      path: inputPath,
      value,
      source: source || null,
      timestamp,
      previous: previous && Number.isFinite(previous.value) ? {
        value: previous.value,
        timestamp: previous.timestamp
      } : null
    })
    runtime.sources[inputPath] = source || null
    runtime.lastInputAt = new Date(timestamp).toISOString()
  }

  function publishCorrectedHeading (rawHeadingRad, source, timestamp) {
    const correctionRad = correctionForHeadingRad(table, rawHeadingRad)
    const correctedHeadingRad = wrap360Rad(rawHeadingRad + correctionRad)
    runtime.status = runtime.learningEnabled ? 'learningAndPublishing' : 'publishing'
    runtime.inputSource = source || null
    runtime.lastRawHeading = rawHeadingRad
    runtime.lastCorrection = correctionRad
    runtime.lastPublishedHeading = correctedHeadingRad
    runtime.lastPublishedAt = new Date(timestamp || Date.now()).toISOString()

    app.handleMessage(PLUGIN_ID, {
      context: options.context || 'vessels.self',
      updates: [
        {
          values: [
            {
              path: options.publishing.path || PUBLISH_PATH,
              value: correctedHeadingRad
            }
          ]
        }
      ]
    })
    setPluginStatus()
  }

  function learnFromCurrentInputs (now) {
    const validation = validateLearningInputs(now)
    if (!validation.ok) {
      recordRejected(validation.reason)
      return
    }

    const headingDeg = radToDeg(wrap360Rad(validation.heading.value))
    const headingTrueDeg = headingDeg + radToDeg(validation.variation.value)
    const cogDeg = radToDeg(validation.cog.value)
    const errorDeg = wrap180Deg(headingTrueDeg - cogDeg)
    const correctionDeg = wrap180Deg(-errorDeg)

    table = updateTableWithObservation(table, {
      headingDeg,
      correctionDeg,
      time: new Date(now).toISOString()
    }, options.table)
    runtime.acceptedSamples += 1
    runtime.lastObservation = {
      at: new Date(now).toISOString(),
      headingDeg: round(headingDeg),
      cogDeg: round(cogDeg),
      sog: validation.sog.value,
      variationDeg: round(radToDeg(validation.variation.value)),
      correctionDeg: round(correctionDeg)
    }
    runtime.lastRejectReason = null
    maybeSaveTable(now)
    setPluginStatus()
  }

  function validateLearningInputs (now) {
    const startupAgeSeconds = (now - startedAt) / 1000
    if (startupAgeSeconds < options.filters.startupDelaySeconds) {
      return { ok: false, reason: 'startup stabilization' }
    }

    const heading = inputs.get(INPUT_PATHS.heading)
    const cog = inputs.get(INPUT_PATHS.cog)
    const sog = inputs.get(INPUT_PATHS.sog)
    const variation = inputs.get(INPUT_PATHS.variation)
    const missing = []
    if (!heading) missing.push('heading')
    if (!cog) missing.push('COG')
    if (!sog) missing.push('SOG')
    if (!variation) missing.push('variation')
    if (missing.length) return { ok: false, reason: `missing ${missing.join(', ')}` }

    const stale = [heading, cog, sog, variation].filter(input => (now - input.timestamp) / 1000 > options.filters.maxSampleAgeSeconds)
    if (stale.length) return { ok: false, reason: `stale ${stale.map(input => input.path).join(', ')}` }

    const sampleSkewSeconds = inputTimestampSkewSeconds([heading, cog, sog, variation])
    if (sampleSkewSeconds > options.filters.maxSampleSkewSeconds) {
      return { ok: false, reason: 'input timestamps are not aligned' }
    }

    if (sog.value < options.filters.minSog) return { ok: false, reason: 'SOG below learning threshold' }

    const cogRate = angleRateDegPerSecond(cog)
    if (Number.isFinite(cogRate) && cogRate > options.filters.maxCogRate) {
      return { ok: false, reason: 'COG is not stable' }
    }

    const headingRate = angleRateDegPerSecond(heading)
    if (Number.isFinite(headingRate) && headingRate > options.filters.maxHeadingRate) {
      return { ok: false, reason: 'heading is not stable' }
    }

    return { ok: true, heading, cog, sog, variation }
  }

  function recordRejected (reason) {
    runtime.rejectedSamples += 1
    runtime.lastRejectReason = reason
    runtime.status = runtime.lastPublishedAt ? 'publishing' : 'waitingForInput'
    setPluginStatus()
  }

  function maybeSaveTable (now) {
    const intervalMs = Math.max(1, Number(options.learning.saveIntervalSeconds || 60)) * 1000
    if (now - lastSaveAt < intervalMs) return
    store.setTable(table)
    lastSaveAt = now
  }

  function checkStaleInput () {
    if (runtime.status === 'error') return
    if (!runtime.lastPublishedAt) {
      runtime.status = 'waitingForInput'
      setPluginStatus()
      return
    }
    const ageSeconds = (Date.now() - new Date(runtime.lastPublishedAt).getTime()) / 1000
    if (ageSeconds > options.publishing.staleAfterSeconds) {
      runtime.status = 'staleInput'
      setPluginStatus()
    }
  }

  function registerWithRouter (router) {
    router.get('/', (req, res) => sendPublicFile(res, 'index.html', 'text/html; charset=utf-8'))
    router.get('/app.js', (req, res) => sendPublicFile(res, 'app.js', 'application/javascript; charset=utf-8'))
    router.get('/styles.css', (req, res) => sendPublicFile(res, 'styles.css', 'text/css; charset=utf-8'))
    router.get('/icon.svg', (req, res) => sendPublicFile(res, 'icon.svg', 'image/svg+xml'))
    router.get('/public/icon.svg', (req, res) => sendPublicFile(res, 'icon.svg', 'image/svg+xml'))

    router.get('/api/state', asyncRoute(async () => publicState()))
    router.post('/api/learning', asyncRoute(async req => {
      const body = await readBody(req)
      runtime.learningEnabled = store.setLearningEnabled(Boolean(body.enabled))
      setPluginStatus()
      return publicState()
    }))
    router.get('/api/table', asyncRoute(async () => tableResponse()))
    router.get('/api/table/export', asyncRoute(async () => tableResponse()))
    router.post('/api/table/import', asyncRoute(async req => {
      const body = await readBody(req)
      table = store.setTable(body.table || body)
      return tableResponse()
    }))
    router.post('/api/table/reset', asyncRoute(async () => {
      table = store.resetTable()
      return tableResponse()
    }))
    router.post('/api/table/sector/manual', asyncRoute(async req => {
      const body = await readBody(req)
      table = setManualCorrection(table, body.headingDeg, body.correctionDeg, options.table)
      if (body.locked === false) table = setSectorLocked(table, body.headingDeg, false, options.table)
      store.setTable(table)
      return tableResponse()
    }))
    router.post('/api/table/sector/reset', asyncRoute(async req => {
      const body = await readBody(req)
      table = resetSector(table, body.headingDeg, options.table)
      store.setTable(table)
      return tableResponse()
    }))
    router.post('/api/table/sector/lock', asyncRoute(async req => {
      const body = await readBody(req)
      table = setSectorLocked(table, body.headingDeg, body.locked !== false, options.table)
      store.setTable(table)
      return tableResponse()
    }))
  }

  function publicState () {
    return {
      id: PLUGIN_ID,
      context: options.context,
      paths: INPUT_PATHS,
      filters: options.filters,
      learningEnabled: runtime.learningEnabled,
      runtime: runtimeSummary(),
      table: tableResponse()
    }
  }

  function tableResponse () {
    const normalized = normalizeTable(table, options.table)
    return {
      summary: summarizeTable(normalized),
      harmonics: normalized.harmonics,
      bins: normalized.bins
    }
  }

  function runtimeSummary () {
    return {
      status: runtime.status,
      inputSource: runtime.inputSource,
      sources: runtime.sources,
      acceptedSamples: runtime.acceptedSamples,
      rejectedSamples: runtime.rejectedSamples,
      lastRejectReason: runtime.lastRejectReason,
      lastObservation: runtime.lastObservation,
      lastInputAt: runtime.lastInputAt,
      lastPublishedAt: runtime.lastPublishedAt,
      lastRawHeadingDeg: runtime.lastRawHeading === null ? null : round(radToDeg(runtime.lastRawHeading)),
      lastCorrectionDeg: runtime.lastCorrection === null ? null : round(radToDeg(runtime.lastCorrection)),
      lastPublishedHeadingDeg: runtime.lastPublishedHeading === null ? null : round(radToDeg(runtime.lastPublishedHeading))
    }
  }

  function setPluginStatus () {
    if (!app.setPluginStatus) return
    const summary = summarizeTable(table)
    const learning = runtime.learningEnabled ? `learning ${runtime.acceptedSamples}/${runtime.rejectedSamples}` : 'learning off'
    const correction = runtime.lastCorrection === null ? 'no heading' : `${round(radToDeg(runtime.lastCorrection))} deg`
    app.setPluginStatus(`${runtime.status}; ${learning}; correction ${correction}; ${summary.usableBinCount}/${summary.binCount} sectors`)
  }
}

function createRuntimeState () {
  return {
    status: 'stopped',
    learningEnabled: false,
    inputSource: null,
    sources: {},
    acceptedSamples: 0,
    rejectedSamples: 0,
    lastRejectReason: null,
    lastObservation: null,
    lastInputAt: null,
    lastPublishedAt: null,
    lastRawHeading: null,
    lastCorrection: null,
    lastPublishedHeading: null
  }
}

function isInputPath (inputPath) {
  return Object.values(INPUT_PATHS).includes(inputPath)
}

function sourceRef (update) {
  return update.$source || update.source && update.source.label || null
}

function normalizeTimestamp (value) {
  if (!value) return null
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

function angleRateDegPerSecond (input) {
  if (!input || !input.previous) return null
  const dt = (input.timestamp - input.previous.timestamp) / 1000
  if (dt <= 0) return null
  return Math.abs(wrap180Deg(radToDeg(input.value - input.previous.value))) / dt
}

function inputTimestampSkewSeconds (inputs) {
  const timestamps = inputs
    .map(input => input && input.timestamp)
    .filter(timestamp => Number.isFinite(timestamp))
  if (timestamps.length < 2) return 0
  return (Math.max(...timestamps) - Math.min(...timestamps)) / 1000
}

function sendPublicFile (res, fileName, contentType) {
  const filePath = path.join(__dirname, 'public', fileName)
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.statusCode = error.code === 'ENOENT' ? 404 : 500
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Could not read file')
      return
    }
    res.setHeader('content-type', contentType)
    res.end(contents)
  })
}

function asyncRoute (handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res))
      .then(result => {
        if (res.headersSent) return
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(result))
      })
      .catch(error => {
        const status = error.statusCode || 500
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: error.message || String(error) }))
      })
  }
}

function readBody (req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body)
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('error', reject)
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        error.statusCode = 400
        reject(error)
      }
    })
  })
}

function mergeOptions (defaults, overrides) {
  const result = { ...defaults }
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && defaults[key] && typeof defaults[key] === 'object') {
      result[key] = mergeOptions(defaults[key], value)
    } else {
      result[key] = value
    }
  }
  return result
}

function round (value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
