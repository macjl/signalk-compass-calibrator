'use strict'

const POLL_MS = 2000
let currentState = null
let editedSector = null

bindEvents()
loadState().catch(showError)
setInterval(() => loadState({ quiet: true }).catch(error => console.warn(error)), POLL_MS)

function bindEvents () {
  document.getElementById('refresh').addEventListener('click', () => runAction(loadState))
  document.getElementById('learningEnabled').addEventListener('change', event => {
    runAction(() => setLearning(event.target.checked))
  })
  document.getElementById('saveSector').addEventListener('click', () => runAction(saveEditedSector))
  document.getElementById('resetSector').addEventListener('click', () => runAction(resetSector))
  document.getElementById('exportTable').addEventListener('click', () => runAction(exportTable))
  document.getElementById('importTable').addEventListener('click', () => document.getElementById('importTableFile').click())
  document.getElementById('importTableFile').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    runAction(() => importTableFile(file)).finally(() => {
      event.target.value = ''
    })
  })
  document.getElementById('resetTable').addEventListener('click', () => runAction(resetTable))
}

async function loadState (options = {}) {
  currentState = await api('/api/state')
  renderState(currentState)
  if (!options.quiet) clearMessage()
}

function renderState (state) {
  document.getElementById('learningEnabled').checked = Boolean(state.learningEnabled)
  renderRuntime(state.runtime || {})
  renderSummary(state.table && state.table.summary || {})
  renderTable(state.table && state.table.bins || [])
  drawPlot(state.table && state.table.bins || [])
}

function renderRuntime (runtime) {
  const rows = [
    ['Status', runtime.status],
    ['Input source', runtime.inputSource],
    ['Heading source', runtime.sources && runtime.sources['navigation.headingMagnetic']],
    ['COG source', runtime.sources && runtime.sources['navigation.courseOverGroundTrue']],
    ['SOG source', runtime.sources && runtime.sources['navigation.speedOverGround']],
    ['Variation source', runtime.sources && runtime.sources['navigation.magneticVariation']],
    ['Raw heading', deg(runtime.lastRawHeadingDeg)],
    ['Correction', deg(runtime.lastCorrectionDeg)],
    ['Published heading', deg(runtime.lastPublishedHeadingDeg)],
    ['Accepted samples', runtime.acceptedSamples],
    ['Rejected samples', runtime.rejectedSamples],
    ['Last reject', runtime.lastRejectReason || 'none'],
    ['Last input', formatDate(runtime.lastInputAt)],
    ['Last publish', formatDate(runtime.lastPublishedAt)]
  ]
  document.getElementById('runtime').innerHTML = rows.map(([label, value]) => metric(label, value)).join('')
}

function renderSummary (summary) {
  const rows = [
    ['Samples', summary.samples],
    ['Coverage', deg(summary.coverageDeg)],
    ['Usable sectors', `${summary.usableBinCount || 0}/${summary.binCount || 0}`],
    ['Learned sectors', summary.learnedBinCount],
    ['Manual sectors', summary.manualBinCount],
    ['Locked sectors', summary.lockedBinCount],
    ['Mean confidence', percent(summary.meanConfidence)],
    ['Updated', formatDate(summary.updatedAt)]
  ]
  document.getElementById('summary').innerHTML = rows.map(([label, value]) => metric(label, value)).join('')
}

function renderTable (bins) {
  document.getElementById('table').innerHTML = table(
    ['Sector', 'Raw', 'Smoothed', 'Samples', 'Stddev', 'Confidence', 'Origin', 'Locked', 'Actions'],
    bins.map(bin => [
      `${bin.fromDeg}-${bin.toDeg} deg`,
      deg(bin.rawCorrectionDeg),
      deg(bin.smoothedCorrectionDeg),
      bin.samples,
      deg(bin.stddevDeg),
      percent(bin.confidence),
      escapeHtml(bin.origin),
      bin.locked ? 'yes' : '',
      `<button type="button" class="tiny" onclick="editSector(${bin.index})">Edit</button>`
    ])
  )
}

window.editSector = function editSector (index) {
  const bin = currentState && currentState.table && currentState.table.bins.find(item => item.index === index)
  if (!bin) return
  editedSector = {
    index: bin.index,
    headingDeg: bin.fromDeg,
    originalCorrectionDeg: isFiniteValue(bin.rawCorrectionDeg) ? Number(bin.rawCorrectionDeg) : null,
    originalLocked: Boolean(bin.locked)
  }
  document.getElementById('sectorDialogTitle').textContent = `Edit ${bin.fromDeg}-${bin.toDeg} deg`
  document.getElementById('sectorLabel').value = `${bin.fromDeg}-${bin.toDeg} deg`
  document.getElementById('manualCorrection').value = isFiniteValue(bin.rawCorrectionDeg) ? fixedNumber(bin.rawCorrectionDeg, 2) : ''
  document.getElementById('manualLocked').checked = Boolean(bin.locked)
  document.getElementById('sectorHint').textContent = bin.origin === 'empty'
    ? 'Saving a correction creates a manual sector value.'
    : 'Changing the correction makes this sector manual. Changing only Locked preserves its origin.'
  document.getElementById('sectorDialog').showModal()
}

async function setLearning (enabled) {
  currentState = await api('/api/learning', { enabled })
  renderState(currentState)
  showOk(enabled ? 'Learning enabled.' : 'Learning disabled.')
}

async function saveEditedSector () {
  if (!editedSector) return
  const nextCorrection = textNumberValue('manualCorrection')
  const nextLocked = document.getElementById('manualLocked').checked
  const correctionChanged = isFiniteValue(nextCorrection) && (
    editedSector.originalCorrectionDeg === null ||
    Math.abs(nextCorrection - editedSector.originalCorrectionDeg) > 0.0001
  )
  const lockChanged = nextLocked !== editedSector.originalLocked

  if (correctionChanged || (isFiniteValue(nextCorrection) && editedSector.originalCorrectionDeg === null)) {
    await api('/api/table/sector/manual', {
      headingDeg: editedSector.headingDeg,
      correctionDeg: nextCorrection,
      locked: nextLocked
    })
  } else if (lockChanged) {
    await api('/api/table/sector/lock', {
      headingDeg: editedSector.headingDeg,
      locked: nextLocked
    })
  } else {
    document.getElementById('sectorDialog').close()
    showOk('No sector change.')
    return
  }

  await loadState({ quiet: true })
  document.getElementById('sectorDialog').close()
  showOk('Sector saved.')
}

async function resetSector () {
  if (!editedSector) return
  await api('/api/table/sector/reset', {
    headingDeg: editedSector.headingDeg
  })
  await loadState({ quiet: true })
  document.getElementById('sectorDialog').close()
  showOk('Sector reset.')
}

async function exportTable () {
  const data = await api('/api/table/export')
  downloadJson(data, tableFileName(data))
  showOk('Table exported as JSON file.')
}

async function importTableFile (file) {
  const raw = await file.text()
  if (!raw.trim()) throw new Error('Selected file is empty')
  const parsed = JSON.parse(raw)
  await api('/api/table/import', parsed.table ? parsed : { table: parsed })
  await loadState({ quiet: true })
  showOk(`Table imported from ${file.name}.`)
}

async function resetTable () {
  await api('/api/table/reset', {})
  await loadState({ quiet: true })
  showOk('Table reset.')
}

function drawPlot (bins) {
  const canvas = document.getElementById('plot')
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  const chart = { left: 72, right: width - 34, top: 24, bottom: height - 54 }
  ctx.clearRect(0, 0, width, height)
  ctx.font = '12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  const values = bins.filter(bin => Number.isFinite(bin.rawCorrectionDeg) || Number.isFinite(bin.smoothedCorrectionDeg))
  const maxAbs = Math.max(5, ...values.flatMap(bin => [Math.abs(bin.rawCorrectionDeg || 0), Math.abs(bin.smoothedCorrectionDeg || 0)]))
  const xFor = heading => chart.left + heading / 360 * (chart.right - chart.left)
  const yFor = correction => chart.bottom - (correction + maxAbs) / (maxAbs * 2) * (chart.bottom - chart.top)

  ctx.strokeStyle = '#d8ded8'
  ctx.lineWidth = 1
  for (const correction of [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs]) {
    const y = yFor(correction)
    ctx.beginPath()
    ctx.moveTo(chart.left, y)
    ctx.lineTo(chart.right, y)
    ctx.stroke()
    ctx.fillStyle = '#65716b'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(deg(correction), chart.left - 8, y)
  }
  for (const heading of [0, 90, 180, 270, 360]) {
    const x = xFor(heading)
    ctx.beginPath()
    ctx.moveTo(x, chart.top)
    ctx.lineTo(x, chart.bottom)
    ctx.stroke()
    ctx.fillStyle = '#65716b'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(`${heading} deg`, x, chart.bottom + 10)
  }

  drawLine(ctx, bins, 'smoothedCorrectionDeg', xFor, yFor, '#11685d', 2.5)
  drawLine(ctx, bins.filter(bin => Number.isFinite(bin.rawCorrectionDeg)), 'rawCorrectionDeg', xFor, yFor, '#8a5a00', 1.4)
  for (const bin of bins) {
    if (!Number.isFinite(bin.rawCorrectionDeg)) continue
    ctx.fillStyle = bin.locked ? '#5a4fcf' : bin.origin === 'manual' ? '#8a5a00' : '#137547'
    ctx.beginPath()
    ctx.arc(xFor(bin.centerDeg), yFor(bin.rawCorrectionDeg), 4, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawLine (ctx, bins, key, xFor, yFor, color, width) {
  const values = bins.filter(bin => Number.isFinite(bin[key]))
  if (!values.length) return
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  values.forEach((bin, index) => {
    const x = xFor(bin.centerDeg)
    const y = yFor(bin[key])
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  if (values.length > 1) {
    const first = values[0]
    ctx.lineTo(xFor(first.centerDeg + 360), yFor(first[key]))
  }
  ctx.stroke()
}

function downloadJson (data, fileName) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function tableFileName (data) {
  const updatedAt = data && data.summary && data.summary.updatedAt || new Date().toISOString()
  const safeDate = String(updatedAt).replace(/[:.]/g, '-').replace(/[^\dTZ-]/g, '')
  return `compass-correction-table-${safeDate || 'export'}.json`
}

async function api (url, body, method) {
  const endpoint = url.replace(/^\/+/, '')
  const requestUrl = new URL(endpoint, `${window.location.origin}/plugins/compass-calibrator/`)
  const request = body === undefined
    ? (method ? { method } : {})
    : {
        method: method || 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }
  const response = await fetch(requestUrl, request)
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
    return { error: text.slice(0, 240) }
  }
}

async function runAction (action) {
  clearMessage()
  try {
    await action()
  } catch (error) {
    showError(error)
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
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value == null || value === '' ? 'none' : String(value))}</strong></div>`
}

function textNumberValue (id) {
  const text = document.getElementById(id).value.trim()
  return text === '' ? null : Number(text)
}

function deg (value) {
  return isFiniteValue(value) ? `${round(Number(value))} deg` : 'none'
}

function percent (value) {
  return isFiniteValue(value) ? `${round(Number(value) * 100, 1)}%` : '0%'
}

function formatDate (value) {
  if (!value) return 'none'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function showOk (message) {
  showMessage(message, 'ok')
}

function showError (error) {
  showMessage(error.message || String(error), 'error')
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

function escapeHtml (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function round (value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function isFiniteValue (value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function fixedNumber (value, digits) {
  return Number(value).toFixed(digits)
}
