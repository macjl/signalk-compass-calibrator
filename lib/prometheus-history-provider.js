'use strict'

const DEFAULT_METRICS = {
  headingMagnetic: 'navigation_headingMagnetic',
  courseOverGroundTrue: 'navigation_courseOverGroundTrue',
  speedOverGround: 'navigation_speedOverGround',
  magneticVariation: 'navigation_magneticVariation',
  rateOfTurn: 'navigation_rateOfTurn'
}

const PATH_TO_METRIC_KEY = {
  'navigation.headingMagnetic': 'headingMagnetic',
  'navigation.courseOverGroundTrue': 'courseOverGroundTrue',
  'navigation.speedOverGround': 'speedOverGround',
  'navigation.magneticVariation': 'magneticVariation',
  'navigation.rateOfTurn': 'rateOfTurn'
}

class PrometheusHistoryProvider {
  constructor (options = {}) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '')
    this.context = options.context || 'vessels.self'
    this.metrics = { ...DEFAULT_METRICS, ...(options.metrics || {}) }
    this.auth = normalizeAuth(options.auth)
    this.fetchImpl = options.fetch || global.fetch
    if (!this.fetchImpl) {
      throw new Error('A fetch implementation is required')
    }
  }

  metricForPath (path) {
    const key = PATH_TO_METRIC_KEY[path]
    return key ? this.metrics[key] : path.replace(/\./g, '_')
  }

  async listSources (path, range = {}) {
    const metric = this.metricForPath(path)
    const sources = await this.labelValues('source')
    const rows = []
    for (const source of sources) {
      const coverage = await this.getCoverage(path, source, range).catch(error => ({
        source,
        path,
        metric,
        error: error.message,
        sampleCount: 0,
        coveragePercent: 0
      }))
      if (coverage.sampleCount > 0) rows.push(coverage)
    }
    return rows
  }

  async discover (paths, range = {}, resolutionSeconds = 30) {
    const result = {}
    for (const path of paths) {
      result[path] = await this.listSources(path, { ...range, resolutionSeconds })
    }
    return result
  }

  async diagnosePath (path, range = {}, resolutionSeconds = 30) {
    const metric = this.metricForPath(path)
    const metricSeries = await this.instantSeries(metric).catch(error => ({ error: error.message, result: [] }))
    const metricMatches = Array.isArray(metricSeries) ? metricSeries : metricSeries.result
    const contexts = unique(metricMatches.map(series => series.metric && series.metric.context).filter(Boolean))
    const sourcesForContext = unique(metricMatches
      .filter(series => !this.context || series.metric && series.metric.context === this.context)
      .map(series => series.metric && series.metric.source)
      .filter(Boolean))
    const rangeSeries = await this.queryRange(this.selector(metric), range, resolutionSeconds)
      .catch(error => ({ error: error.message, result: [] }))
    const rangeMatches = Array.isArray(rangeSeries) ? rangeSeries : rangeSeries.result
    const sampleCount = countRangeSamples(rangeMatches)

    return {
      path,
      metric,
      selector: this.selector(metric),
      metricSeriesCount: metricMatches.length,
      contexts,
      sourcesForSelectedContext: sourcesForContext,
      rangeSeriesCount: rangeMatches.length,
      rangeSampleCount: sampleCount,
      error: metricSeries.error || rangeSeries.error || null
    }
  }

  async getSeries (path, source, range = {}, resolutionSeconds = 1) {
    const metric = this.metricForPath(path)
    const selector = this.selector(metric, source)
    const result = await this.queryRange(selector, range, resolutionSeconds)
    const samples = []
    for (const series of result) {
      for (const [timestamp, value] of series.values || []) {
        const number = Number(value)
        if (Number.isFinite(number)) samples.push({ t: Number(timestamp) * 1000, value: number })
      }
    }
    samples.sort((a, b) => a.t - b.t)
    return samples
  }

  async instantSeries (query) {
    const params = new URLSearchParams({ query })
    const data = await this.request(`/api/v1/query?${params}`)
    return data.result || []
  }

  async queryRange (query, range = {}, resolutionSeconds = 1) {
    const params = new URLSearchParams({
      query,
      start: toUnixSeconds(range.from),
      end: toUnixSeconds(range.to),
      step: String(resolutionSeconds || range.resolutionSeconds || 1)
    })
    const data = await this.request(`/api/v1/query_range?${params}`)
    return data.result || []
  }

  async getCoverage (path, source, range = {}) {
    const resolutionSeconds = Number(range.resolutionSeconds || range.step || 30)
    const samples = await this.getSeries(path, source, range, resolutionSeconds)
    const from = normalizeTime(range.from)
    const to = normalizeTime(range.to)
    const expected = from && to ? Math.max(Math.floor((to - from) / 1000 / resolutionSeconds) + 1, 1) : samples.length
    const values = samples.map(sample => sample.value)
    return {
      path,
      metric: this.metricForPath(path),
      source,
      sampleCount: samples.length,
      firstSample: samples[0] ? new Date(samples[0].t).toISOString() : null,
      lastSample: samples[samples.length - 1] ? new Date(samples[samples.length - 1].t).toISOString() : null,
      latestValue: values.length ? values[values.length - 1] : null,
      coveragePercent: expected ? Math.min(100, Math.round(samples.length / expected * 1000) / 10) : 0
    }
  }

  async labelValues (label) {
    const data = await this.request(`/api/v1/label/${encodeURIComponent(label)}/values`)
    return Array.isArray(data.result) ? data.result : []
  }

  selector (metric, source) {
    const labels = [`context="${escapeLabel(this.context)}"`]
    if (source) labels.push(`source="${escapeLabel(source)}"`)
    return `${metric}{${labels.join(',')}}`
  }

  async request (path) {
    if (!this.baseUrl) throw new Error('Prometheus baseUrl is required')
    let response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: this.headers()
      })
    } catch (error) {
      throw new Error(`Prometheus connection failed: ${error.message}`)
    }
    if (!response.ok) {
      const detail = response.status === 401
        ? 'authentication failed'
        : response.status === 403
          ? 'access forbidden'
          : response.statusText
      throw new Error(`Prometheus request failed: ${response.status} ${detail}`)
    }
    let body
    try {
      body = await response.json()
    } catch (error) {
      throw new Error(`Prometheus returned invalid JSON: ${error.message}`)
    }
    if (body.status && body.status !== 'success') {
      throw new Error(body.error || 'Prometheus request did not succeed')
    }
    return body.data || body
  }

  headers () {
    if (!this.auth || this.auth.type !== 'basic' || !this.auth.username) return {}
    return {
      authorization: `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password || ''}`).toString('base64')}`
    }
  }
}

function normalizeAuth (auth) {
  if (!auth || typeof auth !== 'object') return null
  if (auth.type && auth.type !== 'basic') return null
  if (!auth.username) return null
  return {
    type: 'basic',
    username: String(auth.username),
    password: auth.password ? String(auth.password) : ''
  }
}

function unique (values) {
  return Array.from(new Set(values)).sort()
}

function countRangeSamples (series) {
  return series.reduce((sum, item) => sum + (Array.isArray(item.values) ? item.values.length : 0), 0)
}

function escapeLabel (value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function normalizeTime (value) {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function toUnixSeconds (value) {
  const time = normalizeTime(value)
  if (!time) throw new Error('A valid from/to range is required')
  return String(Math.floor(time / 1000))
}

module.exports = {
  DEFAULT_METRICS,
  PrometheusHistoryProvider
}
