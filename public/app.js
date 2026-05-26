'use strict'

let candidateProfile = null

const paths = {
  heading: 'navigation.headingMagnetic',
  cog: 'navigation.courseOverGroundTrue',
  sog: 'navigation.speedOverGround',
  variation: 'navigation.magneticVariation'
}

setDefaultDates()
bindEvents()
loadRuntime()
loadSources()

function bindEvents () {
  document.getElementById('discover').addEventListener('click', discoverSources)
  document.getElementById('calibrate').addEventListener('click', runCalibration)
  document.getElementById('activate').addEventListener('click', activateCandidate)
  document.getElementById('reject').addEventListener('click', rejectCandidate)
  document.getElementById('refreshRuntime').addEventListener('click', () => {
    loadRuntime()
    loadSources()
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
  document.getElementById('context').value = data.context || 'vessels.self'
  if (data.selected) {
    document.getElementById('headingSource').value = data.selected.heading || ''
    document.getElementById('cogSource').value = data.selected.cog || ''
    document.getElementById('sogSource').value = data.selected.sog || ''
    document.getElementById('variationSource').value = data.selected.variation || ''
  }
}

async function discoverSources () {
  const payload = {
    baseUrl: value('baseUrl'),
    context: value('context'),
    range: {
      from: dateValue('discoverFrom'),
      to: dateValue('discoverTo')
    },
    resolutionSeconds: 30
  }
  const data = await api('/api/discover', payload)
  renderSources(data)
}

function renderSources (data) {
  const rows = []
  for (const [path, sources] of Object.entries(data)) {
    for (const source of sources) {
      rows.push([
        path,
        `<button type="button" data-path="${path}" data-source="${escapeHtml(source.source)}">Use</button>`,
        source.source,
        source.sampleCount,
        source.coveragePercent,
        source.firstSample || '',
        source.lastSample || '',
        formatValue(source.latestValue)
      ])
    }
  }
  document.getElementById('sources').innerHTML = table(
    ['Path', '', 'Source', 'Samples', 'Coverage %', 'First', 'Last', 'Latest'],
    rows
  )
  document.querySelectorAll('#sources button').forEach(button => {
    button.addEventListener('click', () => useSource(button.dataset.path, button.dataset.source))
  })
}

function useSource (path, source) {
  if (path === paths.heading) document.getElementById('headingSource').value = source
  if (path === paths.cog) document.getElementById('cogSource').value = source
  if (path === paths.sog) document.getElementById('sogSource').value = source
  if (path === paths.variation) document.getElementById('variationSource').value = source
}

async function runCalibration () {
  const payload = {
    baseUrl: value('baseUrl'),
    context: value('context'),
    range: {
      from: dateValue('from'),
      to: dateValue('to')
    },
    resolutionSeconds: numberValue('resolution'),
    sources: {
      heading: value('headingSource'),
      cog: value('cogSource'),
      sog: value('sogSource'),
      variation: value('variationSource')
    },
    filters: {
      minSog: numberValue('minSog'),
      maxRateOfTurn: numberValue('maxRateOfTurn'),
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

async function activateCandidate () {
  if (!candidateProfile) return
  candidateProfile = await api(`/api/profiles/${encodeURIComponent(candidateProfile.id)}/activate`, {})
  renderProfile(candidateProfile)
  await loadRuntime()
}

async function rejectCandidate () {
  if (!candidateProfile) return
  candidateProfile = await api(`/api/profiles/${encodeURIComponent(candidateProfile.id)}/reject`, {})
  renderProfile(candidateProfile)
  document.getElementById('activate').disabled = true
  document.getElementById('reject').disabled = true
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
  const basePath = window.location.pathname.endsWith('/') ? window.location.pathname : `${window.location.pathname}/`
  const requestUrl = new URL(endpoint, `${window.location.origin}${basePath}`)
  const options = body === undefined
    ? {}
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
  const response = await fetch(requestUrl, options)
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || response.statusText)
  return payload
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
