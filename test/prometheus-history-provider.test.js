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

test('Prometheus provider includes HTTP error body details', async () => {
  const provider = new PrometheusHistoryProvider({
    baseUrl: 'http://history.example',
    context: 'vessels.self',
    fetch: async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      text: async () => JSON.stringify({ error: 'invalid step value' })
    })
  })

  await assert.rejects(
    () => provider.labelValues('source'),
    /422 Unprocessable Entity: invalid step value/
  )
})


test('Prometheus provider discovers sources from metric labels for selected context', async () => {
  const provider = new PrometheusHistoryProvider({
    baseUrl: 'http://history.example',
    context: 'vessels.self',
    fetch: async url => {
      const parsed = new URL(url)
      const query = parsed.searchParams.get('query')
      if (parsed.pathname.endsWith('/api/v1/query')) {
        return jsonResponse({
          status: 'success',
          data: {
            result: [
              { metric: { context: 'vessels.self', source: 'heading-a' }, value: [0, '1'] },
              { metric: { context: 'vessels.other', source: 'heading-b' }, value: [0, '2'] }
            ]
          }
        })
      }
      if (parsed.pathname.endsWith('/api/v1/query_range')) {
        assert.equal(query, 'navigation_headingMagnetic{context="vessels.self",source="heading-a"}')
        return jsonResponse({
          status: 'success',
          data: {
            result: [
              { metric: { context: 'vessels.self', source: 'heading-a' }, values: [[0, '1'], [1, '1.1']] }
            ]
          }
        })
      }
      return jsonResponse({ status: 'success', data: { result: [] } })
    }
  })

  const sources = await provider.listSources('navigation.headingMagnetic', {
    from: '2026-05-25T00:00:00Z',
    to: '2026-05-25T00:01:00Z'
  })

  assert.equal(sources.length, 1)
  assert.equal(sources[0].source, 'heading-a')
  assert.equal(sources[0].sampleCount, 2)
})

test('Prometheus provider chunks long range queries', async () => {
  const starts = []
  const provider = new PrometheusHistoryProvider({
    baseUrl: 'http://history.example',
    context: 'vessels.self',
    fetch: async url => {
      const parsed = new URL(url)
      starts.push(parsed.searchParams.get('start'))
      return jsonResponse({
        status: 'success',
        data: {
          result: [
            { values: [[Number(parsed.searchParams.get('start')), '1']] }
          ]
        }
      })
    }
  })

  const samples = await provider.getSeriesChunked('navigation.headingMagnetic', 'heading-a', {
    from: '2026-05-25T00:00:00Z',
    to: '2026-05-25T00:00:09Z'
  }, 1, 3)

  assert.deepEqual(starts, ['1779667200', '1779667203', '1779667206', '1779667209'])
  assert.equal(samples.length, 4)
})

function jsonResponse (body) {
  return {
    ok: true,
    json: async () => body
  }
}
