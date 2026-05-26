'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { PrometheusHistoryProvider } = require('../lib/prometheus-history-provider')

test('Prometheus provider sends Basic Auth header when configured', async () => {
  let receivedAuthorization = null
  const provider = new PrometheusHistoryProvider({
    baseUrl: 'http://history.example',
    context: 'vessels.self',
    auth: {
      type: 'basic',
      username: 'alice',
      password: 'secret'
    },
    fetch: async (url, options) => {
      receivedAuthorization = options.headers.authorization
      return {
        ok: true,
        json: async () => ({
          status: 'success',
          data: {
            result: []
          }
        })
      }
    }
  })

  await provider.getSeries('navigation.headingMagnetic', 'heading-a', {
    from: '2026-05-25T00:00:00Z',
    to: '2026-05-25T00:01:00Z'
  })

  assert.equal(receivedAuthorization, 'Basic YWxpY2U6c2VjcmV0')
})

test('Prometheus provider reports authentication failures clearly', async () => {
  const provider = new PrometheusHistoryProvider({
    baseUrl: 'http://history.example',
    context: 'vessels.self',
    fetch: async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    })
  })

  await assert.rejects(
    () => provider.labelValues('source'),
    /401 authentication failed/
  )
})
