'use strict'

let candidateProfile = null
let restoredFields = new Set()
let savedProfiles = []
let selectedProfile = null

const STORAGE_KEY = 'signalk-compass-calibrator.settings.v2'
const SECRET_STORAGE_KEY = 'signalk-compass-calibrator.sessionSecrets.v1'
const MPS_TO_KNOTS = 1.9438444924406

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
loadProfiles().catch(showError)

function bindEvents () {
  bindPersistence()
  bindTabs()
  document.getElementById('discover').addEventListener('click', () => runAction('Discover failed', discoverSources))
  document.getElementById('calibrate').addEventListener('click', () => runAction('Calibration failed', runCalibration))
  document.getElementById('saveCandidate').addEventListener('click', () => runAction('Save failed', saveCandidate))
  document.getElementById('cancelCandidate').addEventListener('click', cancelCandidate)
  document.getElementById('profilesList').addEventListener('click', event => {
    const action = event.target && event.target.dataset && event.target.dataset.action
    const id = event.target && event.target.dataset && event.target.dataset.id
    if (action === 'view' && id) runAction('Load failed', () => loadProfileDetails(id))
  })
  document.getElementById('deleteProfile').addEventListener('click', () => runAction('Delete failed', deleteSelectedProfile))
  document.getElementById('activateRuntime').addEventListener('click', () => runAction('Runtime activation failed', activateRuntime))
  document.getElementById('refreshRuntime').addEventListener('click', () => {
    runAction('Refresh failed', async () => {
      await loadProfiles()
      await loadRuntime()
      await loadSources()
      showOk('Runtime refreshed.')
    })
  })
}

function bindTabs () {
  document.querySelectorAll('.tabButton').forEach(button => {
    button.addEventListener('click', () => showTab(button.dataset.tab))
  })
}

function showTab (id) {
  document.querySelectorAll('.tabButton').forEach(button => {
    button.classList.toggle('active', button.dataset.tab === id)
  })
  document.querySelectorAll('.tabPanel').forEach(panel => {
    panel.classList.toggle('active', panel.id === id)
  })
  if (id === 'calibrationsTab') runAction('Load calibrations failed', loadProfiles)
  if (id === 'runtimeTab') {
    runAction('Load runtime failed', async () => {
      await loadProfiles()
      await loadRuntime()
      await loadSources()
    })
  }
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
  populateRuntimeSources(data.live || [])
}

async function loadProfiles () {
  const data = await api('/api/profiles')
  savedProfiles = data.profiles || []
  renderProfilesList(savedProfiles, data.activeProfileId)
  populateRuntimeProfiles(savedProfiles, data.activeProfileId)
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
        formatSourceLatest(path, source.latestValue)
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
    setNumberIfFinite('minSog', mpsToKnots(recommendations.filters.minSog))
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

function formatSourceLatest (path, latestValue) {
  if (path === paths.sog) return `${formatValue(mpsToKnots(latestValue))} kn`
  return formatValue(latestValue)
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
      minSog: knotsToMps(numberValue('minSog')),
      maxCogRate: numberValue('maxCogRate'),
      minSamplesPerBin: numberValue('minSamplesPerBin')
    },
    calibration: {
      binSize: numberValue('binSize')
    }
  }
  candidateProfile = await api('/api/calibrate', payload)
  renderProfile(candidateProfile)
  document.getElementById('saveCandidate').disabled = false
  document.getElementById('cancelCandidate').disabled = false
  showOk('Calibration completed. Save the table or cancel it.')
}

async function saveCandidate () {
  if (!candidateProfile) return
  const saved = await api('/api/profiles', { profile: candidateProfile })
  candidateProfile = null
  resetCandidateReview()
  await loadProfiles()
  showTab('calibrationsTab')
  await loadProfileDetails(saved.id)
  showOk('Calibration table saved.')
}

function cancelCandidate () {
  candidateProfile = null
  resetCandidateReview()
  showTab('calibrationTab')
  showOk('Candidate calibration discarded.')
}

function resetCandidateReview () {
  document.getElementById('candidate').innerHTML = 'No candidate profile yet.'
  document.getElementById('candidate').className = 'summary muted'
  document.getElementById('table').innerHTML = ''
  clearCanvas('plot')
  document.getElementById('saveCandidate').disabled = true
  document.getElementById('cancelCandidate').disabled = true
}

function renderProfile (profile, target = 'candidate') {
  const ids = profileTargetIds(target)
  document.getElementById(ids.summary).innerHTML = `
    <div class="summaryGrid">
      ${metric('State', profile.state)}
      ${metric('Samples', profile.quality.sampleCount)}
      ${metric('Coverage', `${formatValue(profile.quality.coverageDeg)} deg`)}
      ${metric('Usable bins', profile.quality.usableBinCount)}
      ${metric('Mean error', `${formatValue(profile.quality.meanErrorDeg)} deg`)}
      ${metric('Stddev', `${formatValue(profile.quality.stddevDeg)} deg`)}
    </div>
    ${profile.warnings && profile.warnings.length ? `<p class="warning">${profile.warnings.map(escapeHtml).join('<br>')}</p>` : ''}
    ${renderCalibrationTimeline(profile, target)}
    ${renderSegmentSummary(profile.segments || [])}
  `
  document.getElementById(ids.summary).className = 'summary'
  drawCoverageRose(`${target}GlobalCoverage`, binsFromCorrectionTable(profile.correctionTable || []), numberValue('minSamplesPerBin'))
  document.getElementById(ids.table).innerHTML = table(
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
  drawPlot(profile, ids.plot)
  drawNavigationCoverageRoses(profile.segments || [], target)
}

function profileTargetIds (target) {
  if (target === 'saved') return { summary: 'savedProfile', plot: 'savedPlot', table: 'savedTable' }
  return { summary: 'candidate', plot: 'plot', table: 'table' }
}

function renderSegmentSummary (segments) {
  if (!segments.length) return ''
  return `
    <h3>Selected periods</h3>
    ${table(
      ['From', 'To', 'Moving from', 'Moving to', 'Stable parts', 'Quality', 'Fine step', 'Min SOG', 'Max COG rate', 'SOG median', 'COG rate p90', 'Samples', 'Reason'],
      segments.map(segment => [
        escapeHtml(segment.from || ''),
        escapeHtml(segment.to || ''),
        escapeHtml(segment.movementFrom || ''),
        escapeHtml(segment.movementTo || ''),
        Array.isArray(segment.stableSegments) ? segment.stableSegments.length : '',
        `<span class="quality-${escapeHtml(segment.quality || 'missing')}">${escapeHtml(segment.quality || '')}</span>`,
        segment.stats && segment.stats.analysisResolutionSeconds ? `${formatValue(segment.stats.analysisResolutionSeconds)} s` : '',
        `${formatValue(mpsToKnots(segment.minSog))} kn`,
        `${formatValue(segment.maxCogRate)} deg/s`,
        `${formatValue(mpsToKnots(segment.stats && segment.stats.sogMedian))} kn`,
        `${formatValue(segment.stats && segment.stats.cogRateP90)} deg/s`,
        segment.stats && segment.stats.samples ? `${formatValue(segment.stats.acceptedSamples || 0)} used / ${formatValue(segment.stats.samples.sog)} SOG / ${formatValue(segment.stats.samples.cog)} COG` : '',
        escapeHtml(segment.reason || '')
      ])
    )}
  `
}

function renderCalibrationTimeline (profile, target = 'candidate') {
  const segments = profile.segments || []
  if (!segments.length || !profile.range) return ''
  const range = normalizeRange(profile.range)
  if (!range) return ''
  return `
    <h3>Calibration timeline</h3>
    <div class="coveragePanel">
      <div>
        <h4>Heading coverage</h4>
        <canvas id="${target}GlobalCoverage" class="coverageRose" width="260" height="260"></canvas>
      </div>
      <div class="coverageNotes">
        <p>Radial fill shows samples per heading bin against the minimum samples per bin.</p>
        <p>Rings mark 25%, 50%, 75%, and 100% of the target.</p>
      </div>
    </div>
    <div class="timelineLegend">
      <span><i class="legendNavigation"></i>navigation</span>
      <span><i class="legendStable"></i>COG stable used</span>
      <span><i class="legendRejected"></i>rejected</span>
    </div>
    <div class="timelineScale">
      <span>${escapeHtml(formatDateTime(range.from))}</span>
      <span>${escapeHtml(formatDateTime((range.from + range.to) / 2))}</span>
      <span>${escapeHtml(formatDateTime(range.to))}</span>
    </div>
    <div class="timelineTrack globalTimeline">
      ${segments.map(segment => timelineBlock(segment, range, 'navigation')).join('')}
      ${segments.flatMap(segment => segment.stableSegments || []).map(segment => timelineBlock(segment, range, 'stable')).join('')}
    </div>
    <div class="periodZooms">
      ${segments.map((segment, index) => renderNavigationZoom(segment, index, target)).join('')}
    </div>
  `
}

function renderNavigationZoom (segment, index, target = 'candidate') {
  const range = normalizeRange(segment)
  if (!range) return ''
  const stableSegments = segment.stableSegments || []
  const durationMinutes = Math.round((range.to - range.from) / 6000) / 10
  const coverageDeg = headingCoverageDeg(segment.headingBins || [])
  const acceptedSamples = segment.stats && segment.stats.acceptedSamples || 0
  return `
    <details class="periodZoom" ${index === 0 ? 'open' : ''}>
      <summary>
        <span>Navigation ${index + 1}</span>
        <small>${escapeHtml(formatDateTime(range.from))} - ${escapeHtml(formatDateTime(range.to))} · ${durationMinutes} min · ${acceptedSamples} samples · ${coverageDeg} deg</small>
      </summary>
      <div class="timelineScale">
        <span>${escapeHtml(formatDateTime(range.from))}</span>
        <span>${escapeHtml(formatDateTime((range.from + range.to) / 2))}</span>
        <span>${escapeHtml(formatDateTime(range.to))}</span>
      </div>
      <div class="timelineTrack zoomTimeline">
        ${timelineBlock(segment, range, segment.quality === 'rejected' ? 'rejected' : 'navigation')}
        ${stableSegments.map(stable => timelineBlock(stable, range, 'stable')).join('')}
      </div>
      <div class="zoomSummary">
        ${metric('Stable parts', stableSegments.length)}
        ${metric('Used samples', acceptedSamples)}
        ${metric('Median speed', `${formatValue(mpsToKnots(segment.stats && segment.stats.sogMedian))} kn`)}
        ${metric('COG p90', `${formatValue(segment.stats && segment.stats.cogRateP90)} deg/s`)}
        ${metric('Heading coverage', `${coverageDeg} deg`)}
      </div>
      <canvas id="${target}-coverage-${index}" class="coverageRose small" width="180" height="180"></canvas>
    </details>
  `
}

function timelineBlock (segment, range, type) {
  const segmentRange = normalizeRange(segment)
  if (!segmentRange) return ''
  const left = percent((segmentRange.from - range.from) / (range.to - range.from))
  const width = Math.max(0.3, percent((segmentRange.to - segmentRange.from) / (range.to - range.from)))
  return `<span class="timelineBlock ${type}" style="left:${left}%;width:${width}%" title="${escapeHtml(formatDateTime(segmentRange.from))} - ${escapeHtml(formatDateTime(segmentRange.to))}"></span>`
}

async function loadRuntime () {
  const data = await api('/api/runtime')
  populateRuntimeProfiles(data.profiles || savedProfiles, data.activeProfileId)
  populateRuntimeSources(data.liveSources || [], data.activeInputSource)
  if (data.activeProfileId) document.getElementById('runtimeProfile').value = data.activeProfileId
  if (data.activeInputSource) document.getElementById('runtimeSource').value = data.activeInputSource
  document.getElementById('runtime').innerHTML = `
    <div class="summaryGrid">
      ${metric('Status', data.status)}
      ${metric('Active profile', data.activeProfileId || 'none')}
      ${metric('Input source', data.activeInputSource || data.inputSource || 'none')}
      ${metric('Raw heading', `${formatValue(data.lastRawHeadingDeg)} deg`)}
      ${metric('Correction', `${formatValue(data.lastCorrectionDeg)} deg`)}
      ${metric('Calibrated', `${formatValue(data.lastCalibratedHeadingDeg)} deg`)}
      ${metric('Last input', data.lastInputAt || 'none')}
      ${metric('Last publish', data.lastPublishedAt || 'none')}
    </div>
  `
}

async function activateRuntime () {
  const profileId = value('runtimeProfile')
  const inputSource = value('runtimeSource')
  await api('/api/runtime/config', { profileId, inputSource })
  await loadRuntime()
  showOk('Runtime calibration activated.')
}

function renderProfilesList (profiles, activeProfileId) {
  document.getElementById('profilesList').innerHTML = table(
    ['Saved at', 'State', 'Samples', 'Coverage', 'Stddev', 'Action'],
    profiles.map(profile => [
      escapeHtml(profile.displayName || profile.savedAt || profile.createdAt || profile.id),
      profile.id === activeProfileId ? 'runtime active' : escapeHtml(profile.state || 'saved'),
      profile.quality ? profile.quality.sampleCount : '',
      profile.quality ? `${formatValue(profile.quality.coverageDeg)} deg` : '',
      profile.quality ? `${formatValue(profile.quality.stddevDeg)} deg` : '',
      `<button type="button" data-action="view" data-id="${escapeHtml(profile.id)}">View</button>`
    ])
  )
}

async function loadProfileDetails (id) {
  selectedProfile = await api(`/api/profiles/${encodeURIComponent(id)}`)
  renderProfile(selectedProfile, 'saved')
  document.getElementById('deleteProfile').disabled = false
}

async function deleteSelectedProfile () {
  if (!selectedProfile) return
  await api(`/api/profiles/${encodeURIComponent(selectedProfile.id)}`, undefined, 'DELETE')
  selectedProfile = null
  document.getElementById('savedProfile').innerHTML = 'Select a calibration table.'
  document.getElementById('savedProfile').className = 'summary muted'
  document.getElementById('savedTable').innerHTML = ''
  clearCanvas('savedPlot')
  document.getElementById('deleteProfile').disabled = true
  await loadProfiles()
  await loadRuntime()
  showOk('Calibration table deleted.')
}

function populateRuntimeProfiles (profiles, activeProfileId) {
  const select = document.getElementById('runtimeProfile')
  if (!select) return
  const previous = select.value || activeProfileId || ''
  select.innerHTML = [
    '<option value="">Select table</option>',
    ...profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.displayName || profile.savedAt || profile.createdAt || profile.id)}</option>`)
  ].join('')
  if (previous) select.value = previous
}

function populateRuntimeSources (sources, selectedSource = '') {
  const select = document.getElementById('runtimeSource')
  if (!select) return
  const headingSources = Array.from(new Set([
    ...(sources || [])
    .filter(source => source.paths && source.paths[paths.heading])
    .map(source => source.source)
    .filter(Boolean),
    selectedSource
  ].filter(Boolean))).sort()
  const previous = select.value || selectedSource
  select.innerHTML = [
    '<option value="">Select Signal K source</option>',
    ...headingSources.map(source => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`)
  ].join('')
  if (previous && headingSources.includes(previous)) select.value = previous
}

async function api (url, body, method) {
  const endpoint = url.replace(/^\/+/, '')
  const requestUrl = new URL(endpoint, `${window.location.origin}/plugins/compass-calibrator/`)
  const options = body === undefined
    ? (method ? { method } : {})
    : {
        method: method || 'POST',
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

function clearCanvas (id) {
  const canvas = document.getElementById(id)
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

function drawPlot (profile, canvasId = 'plot') {
  const canvas = document.getElementById(canvasId)
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  const chart = {
    left: 48,
    right: width - 22,
    top: 26,
    bottom: height - 34
  }
  ctx.clearRect(0, 0, width, height)
  ctx.font = '12px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.strokeStyle = '#d8ded8'
  ctx.lineWidth = 1
  const values = profile.correctionTable.filter(bin => Number.isFinite(bin.correctionDeg))
  const maxAbs = Math.max(5, ...values.map(bin => Math.abs(bin.correctionDeg)))
  const yTicks = [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs]
  const xTicks = [0, 90, 180, 270, 360]
  const xFor = heading => chart.left + heading / 360 * (chart.right - chart.left)
  const yFor = correction => chart.bottom - (correction + maxAbs) / (maxAbs * 2) * (chart.bottom - chart.top)

  for (const correction of yTicks) {
    const y = yFor(correction)
    ctx.beginPath()
    ctx.moveTo(chart.left, y)
    ctx.lineTo(chart.right, y)
    ctx.stroke()
    ctx.fillStyle = '#65716b'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${formatValue(correction)} deg`, chart.left - 7, y)
  }

  for (const heading of xTicks) {
    const x = xFor(heading)
    ctx.beginPath()
    ctx.moveTo(x, chart.top)
    ctx.lineTo(x, chart.bottom)
    ctx.stroke()
    ctx.fillStyle = '#65716b'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(`${heading} deg`, x, chart.bottom + 8)
  }

  ctx.fillStyle = '#65716b'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText('Correction', chart.left, 16)
  ctx.textAlign = 'right'
  ctx.fillText('Heading', chart.right, height - 8)

  if (!values.length) return

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

function drawNavigationCoverageRoses (segments, target = 'candidate') {
  segments.forEach((segment, index) => {
    drawCoverageRose(`${target}-coverage-${index}`, segment.headingBins || [], numberValue('minSamplesPerBin'))
  })
}

function drawCoverageRose (canvasId, bins, targetSamples) {
  const canvas = document.getElementById(canvasId)
  if (!canvas || !bins.length) return
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.min(width, height) * 0.38
  const target = Math.max(1, Number(targetSamples || 1))
  ctx.clearRect(0, 0, width, height)
  ctx.font = `${Math.max(10, Math.round(width / 22))}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

  drawCoverageRings(ctx, centerX, centerY, radius)
  const binCount = bins.length
  for (let index = 0; index < binCount; index += 1) {
    const bin = bins[index]
    const samples = Number(bin.samples || 0)
    const fillFraction = Math.max(0, Math.min(1, samples / target))
    const inner = 0
    const outer = radius * fillFraction
    const start = -Math.PI / 2 + index / binCount * Math.PI * 2
    const end = -Math.PI / 2 + (index + 1) / binCount * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.arc(centerX, centerY, outer, start + 0.01, end - 0.01)
    ctx.closePath()
    ctx.fillStyle = samples >= target ? '#137547' : samples > 0 ? '#9b5c00' : '#d8ded8'
    ctx.fill()
    if (inner > 0) ctx.clearRect(centerX - inner, centerY - inner, inner * 2, inner * 2)
  }
  drawCoverageFrame(ctx, centerX, centerY, radius)
}

function drawCoverageRings (ctx, centerX, centerY, radius) {
  ctx.strokeStyle = '#d8ded8'
  ctx.lineWidth = 1
  ctx.fillStyle = '#65716b'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath()
    ctx.arc(centerX, centerY, radius * fraction, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillText(`${Math.round(fraction * 100)}%`, centerX + radius * fraction + 4, centerY)
  }
}

function drawCoverageFrame (ctx, centerX, centerY, radius) {
  ctx.strokeStyle = '#65716b'
  ctx.lineWidth = 1
  for (const heading of [0, 90, 180, 270]) {
    const angle = -Math.PI / 2 + heading / 180 * Math.PI
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius)
    ctx.stroke()
  }
  ctx.fillStyle = '#19211d'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const labels = [
    ['N', centerX, centerY - radius - 12],
    ['E', centerX + radius + 12, centerY],
    ['S', centerX, centerY + radius + 12],
    ['W', centerX - radius - 12, centerY]
  ]
  for (const [label, x, y] of labels) ctx.fillText(label, x, y)
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

function normalizeRange (range) {
  const from = new Date(range.from).getTime()
  const to = new Date(range.to).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
  return { from, to }
}

function percent (fraction) {
  return Math.round(Math.max(0, Math.min(1, fraction)) * 1000) / 10
}

function formatDateTime (input) {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function headingCoverageDeg (bins) {
  return bins.filter(bin => Number(bin.samples || 0) > 0).length * 10
}

function binsFromCorrectionTable (correctionTable) {
  return correctionTable.map(bin => ({
    fromDeg: bin.fromDeg,
    toDeg: bin.toDeg,
    samples: Number(bin.samples || 0)
  }))
}

function mpsToKnots (value) {
  const number = Number(value)
  return Number.isFinite(number) ? number * MPS_TO_KNOTS : null
}

function knotsToMps (value) {
  const number = Number(value)
  return Number.isFinite(number) ? number / MPS_TO_KNOTS : null
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
