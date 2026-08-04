'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const createPlugin = require('../index')
const { degToRad, radToDeg } = require('../lib/angles')
const { buildSchema } = require('../lib/plugin-schema')

test('plugin schema exposes learning filters with runtime defaults', () => {
  const schema = buildSchema()

  assert.equal(schema.properties.context, undefined)
  assert.equal(schema.properties.filters.properties.minSog.default, 1.5)
  assert.equal(schema.properties.filters.properties.maxCogRate.default, 2)
  assert.equal(schema.properties.filters.properties.maxHeadingRate.default, 2)
  assert.equal(schema.properties.filters.properties.maxSampleSkewSeconds.default, 2)
  assert.equal(schema.properties.filters.properties.maxSampleAgeSeconds.default, 3)
  assert.equal(schema.properties.filters.properties.startupDelaySeconds.default, 30)
})

test('plugin subscribes to preferred upstream values with excludeSelf', () => {
  const subscriptions = []
  const app = fakeApp({
    subscribe: (subscription, unsubscribes, errorHandler, callback) => {
      subscriptions.push({ subscription, callback })
    }
  })
  const plugin = createPlugin(app)

  plugin.start({ filters: { startupDelaySeconds: 0 } })

  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0].subscription.sourcePolicy, undefined)
  assert.equal(subscriptions[0].subscription.excludeSelf, true)
  plugin.stop()
})

test('plugin keeps subscription manager errors visible', async () => {
  const app = fakeApp({ subscriptionmanager: null })
  const plugin = createPlugin(app)
  try {
    plugin.start({ filters: { startupDelaySeconds: 0 } })
    await new Promise(resolve => setTimeout(resolve, 1100))

    const state = await getState(plugin)
    assert.equal(state.runtime.status, 'error')
    assert.equal(state.runtime.lastRejectReason, 'Signal K subscription manager is not available')
  } finally {
    plugin.stop()
  }
})

test('plugin publishes neutral heading before learning has data', () => {
  let callback = null
  const messages = []
  const app = fakeApp({
    subscribe: (subscription, unsubscribes, errorHandler, subscribedCallback) => {
      callback = subscribedCallback
    },
    handleMessage: (id, delta) => {
      messages.push({ id, delta })
    }
  })
  const plugin = createPlugin(app)
  plugin.start({ filters: { startupDelaySeconds: 0 } })

  callback({
    updates: [
      {
        $source: 'can0.heading',
        timestamp: new Date().toISOString(),
        values: [{ path: 'navigation.headingMagnetic', value: degToRad(91) }]
      }
    ]
  })

  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, 'compass-calibrator')
  assert.equal(messages[0].delta.updates[0].$source, undefined)
  assert.ok(Math.abs(radToDeg(messages[0].delta.updates[0].values[0].value) - 91) < 0.001)
  plugin.stop()
})

test('plugin rejects learning when input timestamps are not aligned', async () => {
  let callback = null
  const app = fakeApp({
    subscribe: (subscription, unsubscribes, errorHandler, subscribedCallback) => {
      callback = subscribedCallback
    }
  })
  const plugin = createPlugin(app)
  try {
    plugin.start({
      filters: {
        startupDelaySeconds: 0,
        minSog: 0,
        maxSampleAgeSeconds: 10,
        maxSampleSkewSeconds: 2
      }
    })
    await setLearning(plugin, true)

    const now = Date.now()
    callback(delta([
      update('navigation.headingMagnetic', 100, now),
      update('navigation.courseOverGroundTrue', 102, now - 3000),
      update('navigation.speedOverGround', 4, now, { raw: true }),
      update('navigation.magneticVariation', 3, now)
    ]))

    const state = await getState(plugin)
    assert.equal(state.runtime.acceptedSamples, 0)
    assert.equal(state.runtime.lastRejectReason, 'input timestamps are not aligned')
  } finally {
    plugin.stop()
  }
})

test('plugin accepts stale magnetic variation when dynamic inputs are fresh and aligned', async () => {
  let callback = null
  const app = fakeApp({
    subscribe: (subscription, unsubscribes, errorHandler, subscribedCallback) => {
      callback = subscribedCallback
    }
  })
  const plugin = createPlugin(app)
  try {
    plugin.start({
      filters: {
        startupDelaySeconds: 0,
        minSog: 0,
        maxCogRate: 2,
        maxHeadingRate: 2,
        maxSampleAgeSeconds: 3,
        maxSampleSkewSeconds: 2
      }
    })
    await setLearning(plugin, true)

    const now = Date.now()
    callback(delta([
      update('navigation.magneticVariation', 3, now - 600000)
    ]))
    callback(delta([
      update('navigation.headingMagnetic', 100, now),
      update('navigation.courseOverGroundTrue', 102, now),
      update('navigation.speedOverGround', 4, now, { raw: true })
    ]))

    const state = await getState(plugin)
    assert.equal(state.runtime.acceptedSamples, 1)
    assert.equal(state.runtime.lastRejectReason, null)
  } finally {
    plugin.stop()
  }
})

test('plugin rejects learning when magnetic heading changes too fast', async () => {
  let callback = null
  const app = fakeApp({
    subscribe: (subscription, unsubscribes, errorHandler, subscribedCallback) => {
      callback = subscribedCallback
    }
  })
  const plugin = createPlugin(app)
  try {
    plugin.start({
      filters: {
        startupDelaySeconds: 0,
        minSog: 0,
        maxCogRate: 2,
        maxHeadingRate: 2,
        maxSampleAgeSeconds: 60,
        maxSampleSkewSeconds: 2
      }
    })
    await setLearning(plugin, true)

    const start = Date.now() - 30000
    callback(delta([
      update('navigation.headingMagnetic', 200, start),
      update('navigation.courseOverGroundTrue', 203, start),
      update('navigation.speedOverGround', 4, start, { raw: true }),
      update('navigation.magneticVariation', 3, start)
    ]))
    callback(delta([
      update('navigation.headingMagnetic', 290, start + 30000),
      update('navigation.courseOverGroundTrue', 203, start + 30000),
      update('navigation.speedOverGround', 4, start + 30000, { raw: true }),
      update('navigation.magneticVariation', 3, start + 30000)
    ]))

    const state = await getState(plugin)
    assert.equal(state.runtime.acceptedSamples, 1)
    assert.equal(state.runtime.lastRejectReason, 'heading is not stable')
  } finally {
    plugin.stop()
  }
})

function fakeApp (overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-calibrator-test-'))
  return {
    getDataDirPath: () => dataDir,
    setPluginStatus: () => {},
    subscriptionmanager: Object.prototype.hasOwnProperty.call(overrides, 'subscriptionmanager')
      ? overrides.subscriptionmanager
      : {
          subscribe: overrides.subscribe || (() => {})
        },
    handleMessage: overrides.handleMessage || (() => {}),
    debug: () => {},
    error: () => {}
  }
}

function delta (updates) {
  return { updates }
}

function update (inputPath, value, timestamp, options = {}) {
  return {
    $source: 'test.nmea',
    timestamp: new Date(timestamp).toISOString(),
    values: [
      {
        path: inputPath,
        value: options.raw ? value : degToRad(value)
      }
    ]
  }
}

function getState (plugin) {
  return callRoute(plugin, 'get', '/api/state')
}

function setLearning (plugin, enabled) {
  return callRoute(plugin, 'post', '/api/learning', { enabled })
}

function callRoute (plugin, method, routePath, body) {
  let stateHandler = null
  plugin.registerWithRouter({
    get: (path, handler) => {
      if (method === 'get' && path === routePath) stateHandler = handler
    },
    post: (path, handler) => {
      if (method === 'post' && path === routePath) stateHandler = handler
    },
  })

  return new Promise((resolve, reject) => {
    if (!stateHandler) return reject(new Error(`${method.toUpperCase()} ${routePath} handler not registered`))
    const req = { body }
    const res = {
      headersSent: false,
      setHeader: () => {},
      end: payload => {
        try {
          resolve(JSON.parse(payload))
        } catch (error) {
          reject(error)
        }
      }
    }
    stateHandler(req, res)
  })
}
