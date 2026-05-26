'use strict'

const {
  wrap360Rad,
  wrap180Rad,
  wrap180Deg,
  radToDeg,
  degToRad,
  circularMeanDeg,
  angularStddevDeg,
  interpolateCircularDeg
} = require('./angles')

const DEFAULT_FILTERS = {
  minSog: 1.5,
  maxCogRate: 1,
  maxSampleGapSeconds: 2,
  minSamplesPerBin: 10,
  binSize: 10
}

function normalizeTimestamp (value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') return new Date(value).getTime()
  if (typeof value !== 'number') return NaN
  return value < 100000000000 ? value * 1000 : value
}

function normalizeSeries (series) {
  return (series || [])
    .map(sample => ({
      t: normalizeTimestamp(sample.t ?? sample.ts ?? sample.time ?? sample.timestamp),
      value: Number(sample.value)
    }))
    .filter(sample => Number.isFinite(sample.t) && Number.isFinite(sample.value))
    .sort((a, b) => a.t - b.t)
}

function nearestSample (series, targetTime, maxGapMs) {
  if (!series.length) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (series[mid].t < targetTime) lo = mid + 1
    else hi = mid
  }

  const candidates = [series[lo]]
  if (lo > 0) candidates.push(series[lo - 1])
  let best = null
  for (const candidate of candidates) {
    if (!candidate) continue
    const gap = Math.abs(candidate.t - targetTime)
    if (gap <= maxGapMs && (!best || gap < best.gap)) best = { ...candidate, gap }
  }
  return best
}

function buildAlignedSamples (input, filters = {}) {
  const effective = { ...DEFAULT_FILTERS, ...filters }
  const maxGapMs = effective.maxSampleGapSeconds * 1000
  const heading = normalizeSeries(input.heading)
  const cog = normalizeSeries(input.cog)
  const sog = normalizeSeries(input.sog)
  const variation = normalizeSeries(input.variation)
  const aligned = []
  const rejected = {
    missing: 0,
    slow: 0,
    unstableCog: 0
  }

  let previousAccepted = null
  let previousSegmentIndex = null
  for (const headingSample of heading) {
    const localFilters = filtersForTime(headingSample.t, effective)
    if (!localFilters) {
      previousAccepted = null
      previousSegmentIndex = null
      rejected.missing += 1
      continue
    }
    if (previousSegmentIndex !== null && localFilters.segmentIndex !== previousSegmentIndex) {
      previousAccepted = null
    }
    const cogSample = nearestSample(cog, headingSample.t, maxGapMs)
    const sogSample = nearestSample(sog, headingSample.t, maxGapMs)
    const variationSample = nearestSample(variation, headingSample.t, maxGapMs)
    if (!cogSample || !sogSample || !variationSample) {
      rejected.missing += 1
      continue
    }
    if (sogSample.value < localFilters.minSog) {
      rejected.slow += 1
      continue
    }

    if (previousAccepted) {
      const dt = Math.max((headingSample.t - previousAccepted.t) / 1000, 0.001)
      const cogRateDeg = Math.abs(wrap180Deg(radToDeg(cogSample.value - previousAccepted.cogRad))) / dt
      if (cogRateDeg > localFilters.maxCogRate) {
        rejected.unstableCog += 1
        continue
      }
    }

    const rawHeadingDeg = radToDeg(wrap360Rad(headingSample.value))
    const headingTrueDeg = rawHeadingDeg + radToDeg(variationSample.value)
    const cogTrueDeg = radToDeg(cogSample.value)
    const errorDeg = wrap180Deg(headingTrueDeg - cogTrueDeg)
    const correctionDeg = wrap180Deg(-errorDeg)
    const sample = {
      t: headingSample.t,
      headingRad: wrap360Rad(headingSample.value),
      headingDeg: rawHeadingDeg,
      cogRad: cogSample.value,
      cogDeg: radToDeg(cogSample.value),
      sog: sogSample.value,
      variationRad: variationSample.value,
      variationDeg: radToDeg(variationSample.value),
      errorDeg,
      correctionDeg
    }
    aligned.push(sample)
    previousAccepted = sample
    previousSegmentIndex = localFilters.segmentIndex
  }

  return { samples: aligned, rejected }
}

function filtersForTime (time, filters) {
  if (!Array.isArray(filters.segments) || filters.segments.length === 0) return filters
  for (let index = 0; index < filters.segments.length; index += 1) {
    const segment = filters.segments[index]
    if (segment.quality === 'rejected') continue
    const from = normalizeTimestamp(segment.from)
    const to = normalizeTimestamp(segment.to)
    if (time >= from && time <= to) {
      return {
        ...filters,
        minSog: Number(segment.minSog ?? filters.minSog),
        maxCogRate: Number(segment.maxCogRate ?? filters.maxCogRate),
        segmentIndex: index
      }
    }
  }
  return null
}

function buildBins (samples, filters = {}) {
  const effective = { ...DEFAULT_FILTERS, ...filters }
  const binSize = Number(effective.binSize) || DEFAULT_FILTERS.binSize
  const binCount = Math.ceil(360 / binSize)
  const minSamples = Number(effective.minSamplesPerBin) || DEFAULT_FILTERS.minSamplesPerBin
  const bins = Array.from({ length: binCount }, (_, index) => ({
    headingDeg: index * binSize,
    fromDeg: index * binSize,
    toDeg: Math.min((index + 1) * binSize, 360),
    samples: 0,
    quality: 'missing',
    meanErrorDeg: null,
    stddevDeg: null,
    correctionDeg: null,
    interpolated: false,
    _errors: [],
    _corrections: []
  }))

  for (const sample of samples) {
    const index = Math.min(Math.floor(sample.headingDeg / binSize), binCount - 1)
    bins[index].samples += 1
    bins[index]._errors.push(sample.errorDeg)
    bins[index]._corrections.push(sample.correctionDeg)
  }

  for (const bin of bins) {
    if (bin.samples > 0) {
      bin.meanErrorDeg = circularMeanDeg(bin._errors)
      bin.stddevDeg = angularStddevDeg(bin._errors, bin.meanErrorDeg)
      bin.correctionDeg = circularMeanDeg(bin._corrections)
      bin.quality = bin.samples >= minSamples ? 'good' : 'weak'
    }
  }

  interpolateMissingBins(bins)
  return bins.map(({ _errors, _corrections, ...bin }) => bin)
}

function interpolateMissingBins (bins) {
  const reliable = bins
    .map((bin, index) => ({ ...bin, index }))
    .filter(bin => bin.quality === 'good' && Number.isFinite(bin.correctionDeg))

  if (reliable.length < 2) return

  for (let index = 0; index < bins.length; index += 1) {
    const bin = bins[index]
    if (bin.quality === 'good') continue

    let previous = null
    let next = null
    for (let offset = 1; offset <= bins.length; offset += 1) {
      const candidate = reliable.find(item => item.index === (index - offset + bins.length) % bins.length)
      if (candidate) {
        previous = candidate
        break
      }
    }
    for (let offset = 1; offset <= bins.length; offset += 1) {
      const candidate = reliable.find(item => item.index === (index + offset) % bins.length)
      if (candidate) {
        next = candidate
        break
      }
    }

    if (!previous || !next || previous.index === next.index) continue
    const distanceToNext = (next.index - previous.index + bins.length) % bins.length
    const distanceFromPrevious = (index - previous.index + bins.length) % bins.length
    const fraction = distanceFromPrevious / distanceToNext
    bin.correctionDeg = interpolateCircularDeg(previous.correctionDeg, next.correctionDeg, fraction)
    bin.interpolated = true
  }
}

function buildQuality (samples, bins) {
  const goodBins = bins.filter(bin => bin.quality === 'good')
  const errors = samples.map(sample => sample.errorDeg)
  const meanErrorDeg = circularMeanDeg(errors)
  const stddevDeg = angularStddevDeg(errors, meanErrorDeg)
  const coverageDeg = goodBins.reduce((sum, bin) => sum + (bin.toDeg - bin.fromDeg), 0)
  const interpolatedBinCount = bins.filter(bin => bin.interpolated).length

  return {
    sampleCount: samples.length,
    usableBinCount: goodBins.length,
    coverageDeg,
    meanErrorDeg,
    stddevDeg,
    interpolatedBinCount
  }
}

function buildWarnings (profile, filters = {}) {
  const effective = { ...DEFAULT_FILTERS, ...filters }
  const warnings = []
  if (profile.quality.sampleCount < effective.minSamplesPerBin * 4) {
    warnings.push('Too few accepted samples for a robust calibration.')
  }
  if (profile.quality.coverageDeg < 180) {
    warnings.push('Angular coverage is poor; many headings rely on interpolation or have no support.')
  }
  if (profile.quality.usableBinCount < Math.ceil(360 / effective.binSize / 2)) {
    warnings.push('Fewer than half of the heading bins are reliable.')
  }
  if (profile.quality.stddevDeg !== null && profile.quality.stddevDeg > 8) {
    warnings.push('The calibration error has a high standard deviation.')
  }
  if (profile.sources && profile.sources.cog && profile.sources.sog && profile.sources.cog !== profile.sources.sog) {
    warnings.push('COG and SOG sources differ.')
  }
  return warnings
}

function calibrate (input, options = {}) {
  const filters = { ...DEFAULT_FILTERS, ...(options.filters || {}), ...(options.calibration || {}) }
  const { samples, rejected } = buildAlignedSamples(input, filters)
  const correctionTable = buildBins(samples, filters)
  const profile = {
    id: options.id || `profile-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    createdAt: new Date().toISOString(),
    state: options.state || 'candidate',
    range: options.range || null,
    sources: options.sources || {},
    filters,
    quality: buildQuality(samples, correctionTable),
    rejected,
    correctionTable
  }
  profile.warnings = buildWarnings(profile, filters)
  return profile
}

function correctionForHeadingRad (profile, headingRad) {
  return correctionForCompiledProfile(compileCalibrationProfile(profile), headingRad)
}

function compileCalibrationProfile (profile) {
  if (!profile || !Array.isArray(profile.correctionTable) || profile.correctionTable.length === 0) return null

  const bins = []
  for (const bin of profile.correctionTable) {
    if (!Number.isFinite(bin.headingDeg) || !Number.isFinite(bin.correctionDeg) || bin.quality === 'rejected') continue
    bins.push({
      headingRad: wrap360Rad(degToRad(bin.headingDeg)),
      correctionRad: wrap180Rad(degToRad(bin.correctionDeg))
    })
  }
  bins.sort((a, b) => a.headingRad - b.headingRad)
  if (bins.length === 0) return null

  const headingsRad = new Float64Array(bins.length)
  const correctionsRad = new Float64Array(bins.length)
  for (let index = 0; index < bins.length; index += 1) {
    headingsRad[index] = bins[index].headingRad
    correctionsRad[index] = bins[index].correctionRad
  }

  return {
    id: profile.id,
    source: profile.sources && profile.sources.heading || null,
    headingsRad,
    correctionsRad
  }
}

function correctionForCompiledProfile (compiled, headingRad) {
  if (!compiled || !compiled.headingsRad || !compiled.correctionsRad) return null

  const headings = compiled.headingsRad
  const corrections = compiled.correctionsRad
  const count = headings.length
  if (count === 0) return null
  if (count === 1) return corrections[0]

  const heading = wrap360Rad(headingRad)
  let low = 0
  let high = count
  while (low < high) {
    const middle = (low + high) >> 1
    if (headings[middle] < heading) low = middle + 1
    else high = middle
  }

  const wrapsAfterLastBin = low === count
  const upperIndex = wrapsAfterLastBin ? 0 : low
  const lowerIndex = upperIndex === 0 ? count - 1 : upperIndex - 1
  let lowerHeading = headings[lowerIndex]
  let upperHeading = headings[upperIndex]
  let normalizedHeading = heading

  if (wrapsAfterLastBin) upperHeading += Math.PI * 2
  if (low === 0) lowerHeading -= Math.PI * 2
  if (normalizedHeading < lowerHeading) normalizedHeading += Math.PI * 2

  const span = upperHeading - lowerHeading
  const fraction = span > 0 ? (normalizedHeading - lowerHeading) / span : 0
  return wrap180Rad(corrections[lowerIndex] + wrap180Rad(corrections[upperIndex] - corrections[lowerIndex]) * fraction)
}

module.exports = {
  DEFAULT_FILTERS,
  calibrate,
  buildAlignedSamples,
  compileCalibrationProfile,
  correctionForCompiledProfile,
  correctionForHeadingRad
}
