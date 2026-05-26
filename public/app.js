'use strict'

let candidateProfile = null
let restoredFields = new Set()

const STORAGE_KEY = 'signalk-compass-calibrator.settings.v1'
const SECRET_STORAGE_KEY = 'signalk-compass-calibrator.sessionSecrets.v1'

const paths = {
  heading: 'navigation.headingMagnetic',
  cog: 'navigation.courseOverGroundTrue',
  sog: 'navigation.speedOverGround',
  variation: 'navigation.magneticVariation'
}

const sourceInputs = {
  [paths.heading]: {
    inputId: 'headingSource',
    label: 'heading'
  },
  [paths.cog]: {
    inputId: 'cogSource',
    label: 'COG'
  },
  [paths.sog]: {
    inputId: 'sogSource',
    label: 'SOG'
  },
  [paths.variation]: {
    inputId: 'variationSource',
    label: 'variation'
  }
}

const metricInputs = {
  headingMagnetic: 'metricHeadingMagnetic',
  courseOverGroundTrue: 'metricCourseOverGroundTrue',
  speedOverGround: 'metricSpeedOverGround',
  magneticVariation: 'metricMagneticVariation'
}

setDefaultDates()
restorePersistedFields()
bindEvents()
loadRuntime().catch(showError)
loadSources().catch(showError)

function bindEvents () {
  bindPersistence()
  document.getElementById('discover').addEventListener('click', () => runAction('Discover failed', discoverSources))
  document.getElementById('calibrate').addEventListener('click', () => runAction('Calibration failed', runCalibration))
  document.getElementById('activate').addEventListener('click', () => runAction('Activation failed', activateCandidate))
  document.getElementById('reject').addEventListener('click', () => runAction('Reject failed', rejectCandidate))
  document.getElementById('refreshRuntime').addEventListener('click', () => {
    runAction('Refresh failed', async () => {
      await loadRuntime()
      await loadSources()
      showOk('Runtime refreshed.')
    })
  })
}

function setDefaultDates () {
  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  for (const id of ['to', 'discoverTo']) setLocalDate(id, now)
  for (const id of ['from', 'discoverFrom']) setLocalDate(id, yesterday)
}

function setLocalDate (id, date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  document.getElementById(id).value = local.toISOString().slice(0, 16)
}

function dateValue (id) {
  const value = document.getElementById(id).value
  return value ? new Date(value).toISOString() : null
}

async function loadSources () {
  const data = await api('/api/sources')
  setIfNotRestored('context', data.context || 'auto')
  if (data.prometheus) {
    setIfNotRestored('baseUrl', data.prometheus.baseUrl || '')
    setIfNotRestored('historyUsername', data.prometheus.auth && data.prometheus.auth.username || '')
  }
  if (data.metrics) setMetricInputs(data.metrics, true)
  if (data.selected) {
    setIfNotRestored('headingSource', data.selected.heading || '')
    setIfNotRestored('cogSource', data.selected.cog || '')
    setIfNotRestored('sogSource', data.selected.sog || '')
    setIfNotRestored('variationSource', data.selected.variation || '')
  }
}

async function discoverSources () {
  const payload = {
    baseUrl: value('baseUrl'),
    auth: historyAuth(),
    context: '',
    metrics: metricValues(),
    range: {
      from: dateValue('discoverFrom'),
      to: dateValue('discoverTo')
    },
    resolutionSeconds: 30
  }
  const data = await api('/api/discover', payload)
  mirrorDiscoveryRangeToCalibration()
  applyDetectedContext(data.selectedContext || data.detectedContext)
  let count = renderSources(data.paths || data)
  applyRecommendations(data.recommendations)
  renderDiagnostics(data.diagnostics || [])
  if (count === 0) {
    showWarning('Discovery completed, but no historical samples matched these metrics, inferred context, sources and time range.')
  } else {
    showOk(`Historical source discovery completed for ${value('context')}: ${count} source entries found.`)
  }
}

function renderSources (data) {
  const rows = []
  for (const [path, sources] of Object.entries(data)) {
    for (const source of sources) {
      rows.push([
        path,
        source.source,
        source.sampleCount,
        source.coveragePercent,
        source.firstSample || '',
        source.lastSample || '',
        formatValue(source.latestValue)
      ])
    }
  }
  populateSourcePickers(data)
  document.getElementById('sources').innerHTML = table(
    ['Path', 'Source', 'Samples', 'Coverage %', 'First', 'Last', 'Latest'],
    rows
  )
  return rows.length
}

function mirrorDiscoveryRangeToCalibration () {
  document.getElementById('from').value = document.getElementById('discoverFrom').value
  document.getElementById('to').value = document.getElementById('discoverTo').value
  persistFields()
}

function renderDiagnostics (diagnostics) {
  if (!diagnostics.length) {
    document.getElementById('diagnostics').innerHTML = ''
    return
  }
  document.getElementById('diagnostics').innerHTML = `
    <h3>Discovery diagnostics</h3>
    ${table(
      ['Path', 'Metric', 'Selector', 'Instant series', 'Range series', 'Samples', 'Contexts', 'Sources for selected context', 'Error'],
      diagnostics.map(item => [
        escapeHtml(item.path),
        escapeHtml(item.metric),
        `<code>${escapeHtml(item.selector)}</code>`,
        item.metricSeriesCount,
        item.rangeSeriesCount,
        item.rangeSampleCount,
        escapeHtml((item.contexts || []).join(', ')),
        escapeHtml((item.sourcesForSelectedContext || []).join(', ')),
        item.error ? `<span class="error">${escapeHtml(item.error)}</span>` : ''
      ])
    )}
  `
}

function applyDetectedContext (context) {
  if (!context) return
  document.getElementById('context').value = context
  persistFields()
}

function populateSourcePickers (data) {
  for (const [path, target] of Object.entries(sourceInputs)) {
    const sources = Array.isArray(data[path]) ? data[path] : []
    const unique = bestSources(sources)
    const select = document.getElementById(target.inputId)
    const previous = select.value
    select.innerHTML = [
      '<option value="">Select source</option>',
      ...unique.map(source => `<option value="${escapeHtml(source.source)}">${escapeHtml(source.source)} (${source.sampleCount} samples, ${source.coveragePercent}% coverage)</option>`)
    ].join('')
    if (previous && unique.some(source => source.source === previous)) {
      select.value = previous
    } else if (unique.length > 0) {
      select.value = unique[0].source
      persistFields()
    }
  }
}

function applyRecommendations (recommendations) {
  if (!recommendations || recommendations.error) return

  if (recommendations.sources) {
    for (const [key, source] of Object.entries(recommendations.sources)) {
      const path = {
        heading: paths.heading,
        cog: paths.cog,
        sog: paths.sog,
        variation: paths.variation
      }[key]
      const target = sourceInputs[path]
      if (target && source) {
        document.getElementById(target.inputId).value = source
      }
    }
  }

  if (recommendations.filters) {
    setNumberIfFinite('minSog', recommendations.filters.minSog)
    setNumberIfFinite('maxCogRate', recommendations.filters.maxCogRate)
    setNumberIfFinite('minSamplesPerBin', recommendations.filters.minSamplesPerBin)
  }
  if (recommendations.calibration) {
    setNumberIfFinite('binSize', recommendations.calibration.binSize)
  }
  persistFields()
}

function setNumberIfFinite (id, nextValue) {
  if (!Number.isFinite(Number(nextValue))) return
  const element = document.getElementById(id)
  if (element) element.value = String(nextValue)
}

function bestSources (sources) {
  const bySource = new Map()
  for (const source of sources) {
    if (!source.source) continue
    const previous = bySource.get(source.source)
    if (!previous || sourceScore(source) > sourceScore(previous)) {
      bySource.set(source.source, source)
    }
  }
  return Array.from(bySource.values()).sort((a, b) => sourceScore(b) - sourceScore(a))
}

function sourceScore (source) {
  return Number(source.coveragePercent || 0) * 1000000 + Number(source.sampleCount || 0)
}

async function runCalibration () {
  const payload = {
    baseUrl: value('baseUrl'),
    auth: historyAuth(),
    context: value('context'),
    metrics: metricValues(),
    range: {
      from: dateValue('from'),
      to: dateValue('to')
    },
    sources: {
      heading: value('headingSource'),
      cog: value('cogSource'),
      sog: value('sogSource'),
      variation: value('variationSource')
    },
    filters: {
      minSog: numberValue('minSog'),
      maxCogRate: numberValue('maxCogRate'),
      minSamplesPerBin: numberValue('minSamplesPerBin')
    },
    calibration: {
      binSize: numberValue('binSize')
    }
  }
  candidateProfile = await api('/api/calibrate', payload)
  renderProfile(candidateProfile)
  document.getElementById('activate').disabled = false
  document.getElementById('reject').disabled = false
  showOk('Calibration completed. Review the candidate profile before activation.')
}

function renderProfile (profile) {
  document.getElementById('candidate').innerHTML = `
    <div class="summaryGrid">
      ${metric('State', profile.state)}
      ${metric('Samples', profile.quality.sampleCount)}
      ${metric('Coverage', `${formatValue(profile.quality.coverageDeg)} deg`)}
      ${metric('Usable bins', profile.quality.usableBinCount)}
      ${metric('Mean error', `${formatValue(profile.quality.meanErrorDeg)} deg`)}
      ${metric('Stddev', `${formatValue(profile.quality.stddevDeg)} deg`)}
    </div>
    ${profile.warnings && profile.warnings.length ? `<p class="warning">${profile.warnings.map(escapeHtml).join('<br>')}</p>` : ''}
    ${renderSegmentSummary(profile.segments || [])}
  `
  document.getElementById('table').innerHTML = table(
    ['Heading', 'Correction', 'Samples', 'Mean error', 'Stddev', 'Quality', 'Interpolated'],
    profile.correctionTable.map(bin => [
      `${bin.headingDeg} deg`,
      `${formatValue(bin.correctionDeg)} deg`,
      bin.samples,
      `${formatValue(bin.meanErrorDeg)} deg`,
      `${formatValue(bin.stddevDeg)} deg`,
      `<span class="quality-${bin.quality}">${bin.quality}</span>`,
      bin.interpolated ? 'yes' : ''
    ])
  )
  drawPlot(profile)
}

function renderSegmentSummary (segments) {
  if (!segments.length) return ''
  return `
    <h3>Selected periods</h3>
    ${table(
      ['From', 'To', 'Moving from', 'Moving to', 'Quality', 'Fine step', 'Min SOG', 'Max COG rate', 'SOG median', 'COG rate p90', 'Samples', 'Reason'],
      segments.map(segment => [
        escapeHtml(segment.from || ''),
        escapeHtml(segment.to || ''),
        escapeHtml(segment.movementFrom || ''),
        escapeHtml(segment.movementTo || ''),
        `<span class="quality-${escapeHtml(segment.quality || 'missing')}">${escapeHtml(segment.quality || '')}</span>`,
        segment.stats && segment.stats.analysisResolutionSeconds ? `${formatValue(segment.stats.analysisResolutionSeconds)} s` : '',
        `${formatValue(segment.minSog)} m/s`,
        `${formatValue(segment.maxCogRate)} deg/s`,
        `${formatValue(segment.stats && segment.stats.sogMedian)} m/s`,
        `${formatValue(segment.stats && segment.stats.cogRateP90)} deg/s`,
        segment.stats && segment.stats.samples ? `${formatValue(segment.stats.samples.sog)} SOG / ${formatValue(segment.stats.samples.cog)} COG` : '',
        escapeHtml(segment.reason || '')
      ])
    )}
  `
}

async function activateCandidate () {
  if (!candidateProfile) return
  candidateProfile = await api(`/api/profiles/${encodeURIComponent(candidateProfile.id)}/activate`, {})
  renderProfile(candidateProfile)
  await loadRuntime()
  showOk('Candidate profile activated.')
}

async function rejectCandidate () {
  if (!candidateProfile) return
  candidateProfile = await api(`/api/profiles/${encodeURIComponent(candidateProfile.id)}/reject`, {})
  renderProfile(candidateProfile)
  document.getElementById('activate').disabled = true
  document.getElementById('reject').disabled = true
  showOk('Candidate profile rejected.')
}

async function loadRuntime () {
  const data = await api('/api/runtime')
  document.getElementById('runtime').innerHTML = `
    <div class="summaryGrid">
      ${metric('Status', data.status)}
      ${metric('Active profile', data.activeProfileId || 'none')}
      ${metric('Input source', data.inputSource || 'none')}
      ${metric('Raw heading', `${formatValue(data.lastRawHeadingDeg)} deg`)}
      ${metric('Correction', `${formatValue(data.lastCorrectionDeg)} deg`)}
      ${metric('Calibrated', `${formatValue(data.lastCalibratedHeadingDeg)} deg`)}
      ${metric('Last input', data.lastInputAt || 'none')}
      ${metric('Last publish', data.lastPublishedAt || 'none')}
    </div>
  `
}

async function api (url, body) {
  const endpoint = url.replace(/^\/+/, '')
  const requestUrl = new URL(endpoint, `${window.location.origin}/plugins/compass-calibrator/`)
  const options = body === undefined
    ? {}
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
  const response = await fetch(requestUrl, options)
  const payload = await parseResponse(response)
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`)
  return payload
}

async function parseResponse (response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    return {
      error: `${response.status} ${response.statusText}: ${text.slice(0, 240)}`
    }
  }
}

async function runAction (fallback, action) {
  clearMessage()
  try {
    await action()
  } catch (error) {
    showError(error, fallback)
  }
}

function historyAuth () {
  const username = value('historyUsername')
  const password = value('historyPassword')
  if (!username && !password) return null
  return {
    type: 'basic',
    username,
    password
  }
}

function metricValues () {
  return Object.fromEntries(
    Object.entries(metricInputs).map(([key, id]) => [key, value(id)])
  )
}

function setMetricInputs (metrics, keepRestored = false) {
  for (const [key, id] of Object.entries(metricInputs)) {
    if (metrics[key]) {
      if (keepRestored) setIfNotRestored(id, metrics[key])
      else document.getElementById(id).value = metrics[key]
    }
  }
}

function showOk (message) {
  showMessage(message, 'ok')
}

function showWarning (message) {
  showMessage(message, 'warning')
}

function showError (error, fallback = 'Request failed') {
  showMessage(`${fallback}: ${error.message || error}`, 'error')
}

function showMessage (message, type) {
  const element = document.getElementById('message')
  element.hidden = false
  element.className = `message ${type}`
  element.textContent = message
}

function clearMessage () {
  const element = document.getElementById('message')
  element.hidden = true
  element.className = 'message'
  element.textContent = ''
}

function drawPlot (profile) {
  const canvas = document.getElementById('plot')
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  ctx.clearRect(0, 0, width, height)
  ctx.strokeStyle = '#d8ded8'
  ctx.lineWidth = 1
  for (let y = 30; y < height; y += 50) {
    ctx.beginPath()
    ctx.moveTo(40, y)
    ctx.lineTo(width - 20, y)
    ctx.stroke()
  }
  ctx.fillStyle = '#65716b'
  ctx.fillText('Correction deg', 40, 18)
  ctx.fillText('Heading deg', width - 105, height - 10)

  const values = profile.correctionTable.filter(bin => Number.isFinite(bin.correctionDeg))
  if (!values.length) return
  const maxAbs = Math.max(5, ...values.map(bin => Math.abs(bin.correctionDeg)))
  const xFor = heading => 40 + heading / 360 * (width - 70)
  const yFor = correction => height / 2 - correction / maxAbs * (height / 2 - 32)

  ctx.strokeStyle = '#11685d'
  ctx.lineWidth = 2
  ctx.beginPath()
  values.forEach((bin, index) => {
    const x = xFor(bin.headingDeg)
    const y = yFor(bin.correctionDeg)
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()

  for (const bin of values) {
    ctx.fillStyle = bin.quality === 'good' ? '#137547' : '#9b5c00'
    ctx.beginPath()
    ctx.arc(xFor(bin.headingDeg), yFor(bin.correctionDeg), bin.interpolated ? 3 : 4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function table (headers, rows) {
  if (!rows.length) return '<p class="muted">No data.</p>'
  return `
    <table>
      <thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  `
}

function metric (label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`
}

function value (id) {
  return document.getElementById(id).value.trim()
}

function bindPersistence () {
  for (const id of persistedFieldIds()) {
    const element = document.getElementById(id)
    if (!element) continue
    element.addEventListener('input', persistFields)
    element.addEventListener('change', persistFields)
  }
}

function persistedFieldIds () {
  return [
    'context',
    'baseUrl',
    'historyUsername',
    'discoverFrom',
    'discoverTo',
    'headingSource',
    'cogSource',
    'sogSource',
    'variationSource',
    'from',
    'to',
    'minSog',
    'maxCogRate',
    'binSize',
    'minSamplesPerBin',
    ...Object.values(metricInputs)
  ]
}

function restorePersistedFields () {
  const values = readStoredJson(localStorage, STORAGE_KEY)
  restoredFields = new Set()
  for (const [id, fieldValue] of Object.entries(values)) {
    const element = document.getElementById(id)
    if (!element || fieldValue === undefined || fieldValue === null) continue
    element.value = fieldValue
    restoredFields.add(id)
  }

  const secrets = readStoredJson(sessionStorage, SECRET_STORAGE_KEY)
  if (secrets.historyPassword) {
    const password = document.getElementById('historyPassword')
    password.value = secrets.historyPassword
    restoredFields.add('historyPassword')
  }
}

function persistFields () {
  const values = {}
  for (const id of persistedFieldIds()) {
    const element = document.getElementById(id)
    if (element) values[id] = element.value
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(values))
  sessionStorage.setItem(SECRET_STORAGE_KEY, JSON.stringify({
    historyPassword: document.getElementById('historyPassword').value
  }))
}

function readStoredJson (storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || '{}')
  } catch (error) {
    return {}
  }
}

function setIfNotRestored (id, nextValue) {
  if (restoredFields.has(id)) return
  const element = document.getElementById(id)
  if (element) element.value = nextValue
}

function numberValue (id) {
  return Number(document.getElementById(id).value)
}

function formatValue (input) {
  if (input === null || input === undefined || Number.isNaN(input)) return ''
  if (typeof input === 'number') return Math.round(input * 100) / 100
  return input
}

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]))
}
