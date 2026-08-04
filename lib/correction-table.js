'use strict'

const {
  wrap360Rad,
  wrap180Deg,
  radToDeg,
  degToRad
} = require('./angles')

const DEFAULT_TABLE_OPTIONS = {
  binSize: 10,
  harmonicOrder: 3,
  manualWeight: 5,
  emptyBinWeight: 0.05,
  minSamplesForLearned: 20,
  minSamplesForConfidence: 30,
  maxStddevForConfidence: 8
}

function createCorrectionTable (options = {}) {
  const effective = normalizeOptions(options)
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    options: effective,
    bins: Array.from({ length: binCount(effective.binSize) }, (_, index) => emptyBin(index, effective.binSize))
  }
}

function normalizeTable (table, options = {}) {
  const effective = normalizeOptions({
    ...(table && table.options || {}),
    ...options
  })
  const expectedCount = binCount(effective.binSize)
  const bins = Array.from({ length: expectedCount }, (_, index) => normalizeBin(
    table && Array.isArray(table.bins) ? table.bins[index] : null,
    index,
    effective.binSize
  ))
  return recomputeHarmonics({
    version: 1,
    createdAt: table && table.createdAt || new Date().toISOString(),
    updatedAt: table && table.updatedAt || null,
    options: effective,
    bins
  })
}

function updateTableWithObservation (table, observation, options = {}) {
  const next = normalizeTable(table, options)
  const correctionDeg = Number(observation && observation.correctionDeg)
  const headingDeg = Number(observation && observation.headingDeg)
  if (!Number.isFinite(correctionDeg) || !Number.isFinite(headingDeg)) return next

  const index = binIndexForHeading(headingDeg, next.options.binSize)
  const bin = next.bins[index]
  if (bin.locked) return next

  const now = observation && observation.time || new Date().toISOString()
  const weight = positiveNumber(observation && observation.weight, 1)
  const previousWeight = positiveNumber(bin.effectiveSamples, bin.samples || 0)
  const previousMean = Number.isFinite(bin.correctionDeg) ? bin.correctionDeg : correctionDeg
  const nextWeight = previousWeight + weight
  const delta = wrap180Deg(correctionDeg - previousMean)
  const mean = wrap180Deg(previousMean + delta * weight / nextWeight)
  const delta2 = wrap180Deg(correctionDeg - mean)
  const m2 = Math.max(0, Number(bin.m2 || 0) + weight * delta * delta2)

  Object.assign(bin, {
    correctionDeg: round(mean),
    rawCorrectionDeg: round(mean),
    samples: Number(bin.samples || 0) + 1,
    effectiveSamples: round(nextWeight, 3),
    m2: round(m2, 6),
    stddevDeg: stddev(m2, nextWeight),
    origin: shouldBecomeLearned(bin, next) ? 'learned' : (bin.origin === 'manual' ? 'manual' : 'learned'),
    firstUpdated: bin.firstUpdated || now,
    lastUpdated: now,
    lastObservationDeg: round(correctionDeg),
    confidence: 0
  })
  bin.confidence = confidenceForBin(bin, next.options)
  next.updatedAt = now
  return recomputeHarmonics(next)
}

function setManualCorrection (table, headingDeg, correctionDeg, options = {}) {
  const next = normalizeTable(table, options)
  const index = binIndexForHeading(headingDeg, next.options.binSize)
  const bin = next.bins[index]
  const value = wrap180Deg(Number(correctionDeg))
  if (!Number.isFinite(value)) return next
  const now = new Date().toISOString()
  Object.assign(bin, {
    correctionDeg: round(value),
    rawCorrectionDeg: round(value),
    samples: 0,
    effectiveSamples: positiveNumber(next.options.manualWeight, DEFAULT_TABLE_OPTIONS.manualWeight),
    m2: 0,
    stddevDeg: null,
    origin: 'manual',
    locked: true,
    firstUpdated: now,
    lastUpdated: now,
    lastObservationDeg: null,
    confidence: 0.35
  })
  next.updatedAt = now
  return recomputeHarmonics(next)
}

function resetSector (table, headingDeg, options = {}) {
  const next = normalizeTable(table, options)
  const index = binIndexForHeading(headingDeg, next.options.binSize)
  next.bins[index] = emptyBin(index, next.options.binSize)
  next.updatedAt = new Date().toISOString()
  return recomputeHarmonics(next)
}

function setSectorLocked (table, headingDeg, locked, options = {}) {
  const next = normalizeTable(table, options)
  const index = binIndexForHeading(headingDeg, next.options.binSize)
  next.bins[index].locked = Boolean(locked)
  next.updatedAt = new Date().toISOString()
  return recomputeHarmonics(next)
}

function correctionForHeadingRad (table, headingRad) {
  const normalized = normalizeTable(table)
  const headingDeg = radToDeg(wrap360Rad(headingRad))
  const correctionDeg = correctionForHeadingDeg(normalized, headingDeg)
  return degToRad(correctionDeg)
}

function correctionForHeadingDeg (table, headingDeg) {
  const normalized = normalizeTable(table)
  if (!hasCorrections(normalized)) return 0
  const index = binIndexForHeading(headingDeg, normalized.options.binSize)
  const bin = normalized.bins[index]
  if (Number.isFinite(bin.smoothedCorrectionDeg)) return bin.smoothedCorrectionDeg
  if (Number.isFinite(bin.correctionDeg)) return bin.correctionDeg
  return 0
}

function summarizeTable (table) {
  const normalized = normalizeTable(table)
  const usableBins = normalized.bins.filter(bin => Number.isFinite(bin.correctionDeg))
  const lockedBins = normalized.bins.filter(bin => bin.locked)
  const manualBins = normalized.bins.filter(bin => bin.origin === 'manual')
  const learnedBins = normalized.bins.filter(bin => bin.origin === 'learned')
  const samples = normalized.bins.reduce((sum, bin) => sum + Number(bin.samples || 0), 0)
  const meanConfidence = usableBins.length
    ? usableBins.reduce((sum, bin) => sum + Number(bin.confidence || 0), 0) / usableBins.length
    : 0
  return {
    binSize: normalized.options.binSize,
    binCount: normalized.bins.length,
    samples,
    usableBinCount: usableBins.length,
    coverageDeg: usableBins.length * normalized.options.binSize,
    lockedBinCount: lockedBins.length,
    manualBinCount: manualBins.length,
    learnedBinCount: learnedBins.length,
    meanConfidence: round(meanConfidence, 3),
    updatedAt: normalized.updatedAt
  }
}

function recomputeHarmonics (table) {
  const bins = table.bins
  const valid = bins.filter(bin => Number.isFinite(bin.correctionDeg))
  if (valid.length === 0) {
    for (const bin of bins) bin.smoothedCorrectionDeg = 0
    table.harmonics = { order: 0, coefficients: [0], fitted: false }
    return table
  }

  const requestedOrder = Math.max(0, Math.floor(Number(table.options.harmonicOrder || 0)))
  const fitBins = bins.map(bin => Number.isFinite(bin.correctionDeg)
    ? bin
    : {
        ...bin,
        correctionDeg: 0,
        confidence: 0,
        effectiveSamples: positiveNumber(table.options.emptyBinWeight, DEFAULT_TABLE_OPTIONS.emptyBinWeight),
        virtualEmptyCorrection: true
      })
  const order = Math.min(requestedOrder, Math.floor((fitBins.length - 1) / 2))
  if (order < 1) {
    applySparseSmoothing(bins)
    table.harmonics = {
      order: 0,
      coefficients: [],
      fitted: false,
      reason: 'insufficient harmonic order'
    }
    return table
  }

  const coefficients = fitHarmonics(fitBins, order)
  if (!coefficients) {
    applySparseSmoothing(bins)
    table.harmonics = { order: 0, coefficients: [], fitted: false, reason: 'fit failed' }
    return table
  }

  for (const bin of bins) {
    bin.smoothedCorrectionDeg = round(wrap180Deg(evaluateHarmonics(coefficients, bin.centerDeg)))
  }
  table.harmonics = { order, coefficients: coefficients.map(value => round(value, 8)), fitted: true }
  return table
}

function applySparseSmoothing (bins) {
  for (const bin of bins) {
    bin.smoothedCorrectionDeg = Number.isFinite(bin.correctionDeg) ? bin.correctionDeg : 0
  }
}

function fitHarmonics (bins, order) {
  const parameterCount = 1 + order * 2
  const matrix = Array.from({ length: parameterCount }, () => Array(parameterCount).fill(0))
  const vector = Array(parameterCount).fill(0)

  for (const bin of bins) {
    const basis = harmonicBasis(bin.centerDeg, order)
    const y = Number(bin.correctionDeg)
    const weight = bin.virtualEmptyCorrection
      ? positiveNumber(bin.effectiveSamples, DEFAULT_TABLE_OPTIONS.emptyBinWeight)
      : Math.max(0.05, Number(bin.confidence || 0.2), Math.min(Number(bin.effectiveSamples || bin.samples || 1), 50) / 50)
    for (let row = 0; row < parameterCount; row += 1) {
      vector[row] += weight * basis[row] * y
      for (let column = 0; column < parameterCount; column += 1) {
        matrix[row][column] += weight * basis[row] * basis[column]
      }
    }
  }

  for (let index = 0; index < parameterCount; index += 1) {
    matrix[index][index] += 1e-6
  }
  return solveLinearSystem(matrix, vector)
}

function evaluateHarmonics (coefficients, headingDeg) {
  const order = (coefficients.length - 1) / 2
  const basis = harmonicBasis(headingDeg, order)
  return basis.reduce((sum, value, index) => sum + value * coefficients[index], 0)
}

function harmonicBasis (headingDeg, order) {
  const radians = degToRad(headingDeg)
  const basis = [1]
  for (let harmonic = 1; harmonic <= order; harmonic += 1) {
    basis.push(Math.sin(harmonic * radians), Math.cos(harmonic * radians))
  }
  return basis
}

function solveLinearSystem (matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, index) => [...row, vector[index]])
  for (let column = 0; column < n; column += 1) {
    let pivot = column
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row
    }
    if (Math.abs(a[pivot][column]) < 1e-12) return null
    if (pivot !== column) {
      const tmp = a[column]
      a[column] = a[pivot]
      a[pivot] = tmp
    }
    const divisor = a[column][column]
    for (let col = column; col <= n; col += 1) a[column][col] /= divisor
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue
      const factor = a[row][column]
      for (let col = column; col <= n; col += 1) a[row][col] -= factor * a[column][col]
    }
  }
  return a.map(row => row[n])
}

function emptyBin (index, binSize) {
  const fromDeg = index * binSize
  return {
    index,
    fromDeg,
    toDeg: Math.min(fromDeg + binSize, 360),
    centerDeg: wrapHeadingCenter(fromDeg + binSize / 2),
    correctionDeg: null,
    rawCorrectionDeg: null,
    smoothedCorrectionDeg: 0,
    samples: 0,
    effectiveSamples: 0,
    m2: 0,
    stddevDeg: null,
    confidence: 0,
    origin: 'empty',
    locked: false,
    firstUpdated: null,
    lastUpdated: null,
    lastObservationDeg: null
  }
}

function normalizeBin (bin, index, binSize) {
  const empty = emptyBin(index, binSize)
  if (!bin) return empty
  const correctionDeg = isFiniteValue(bin.correctionDeg) ? wrap180Deg(Number(bin.correctionDeg)) : null
  const effectiveSamples = Math.max(0, Number(bin.effectiveSamples || bin.samples || 0))
  const normalized = {
    ...empty,
    correctionDeg,
    rawCorrectionDeg: isFiniteValue(bin.rawCorrectionDeg) ? wrap180Deg(Number(bin.rawCorrectionDeg)) : correctionDeg,
    smoothedCorrectionDeg: isFiniteValue(bin.smoothedCorrectionDeg) ? wrap180Deg(Number(bin.smoothedCorrectionDeg)) : 0,
    samples: Math.max(0, Math.floor(Number(bin.samples || 0))),
    effectiveSamples,
    m2: Math.max(0, Number(bin.m2 || 0)),
    stddevDeg: isFiniteValue(bin.stddevDeg) ? Number(bin.stddevDeg) : null,
    confidence: Math.max(0, Math.min(1, Number(bin.confidence || 0))),
    origin: correctionDeg === null ? 'empty' : (bin.origin === 'manual' ? 'manual' : 'learned'),
    locked: Boolean(bin.locked),
    firstUpdated: bin.firstUpdated || null,
    lastUpdated: bin.lastUpdated || null,
    lastObservationDeg: isFiniteValue(bin.lastObservationDeg) ? wrap180Deg(Number(bin.lastObservationDeg)) : null
  }
  normalized.stddevDeg = stddev(normalized.m2, normalized.effectiveSamples)
  normalized.confidence = normalized.origin === 'empty' ? 0 : confidenceForBin(normalized, normalizeOptions({ binSize }))
  return normalized
}

function shouldBecomeLearned (bin, table) {
  if (bin.origin !== 'manual') return true
  return Number(bin.samples || 0) + 1 >= Number(table.options.minSamplesForLearned || DEFAULT_TABLE_OPTIONS.minSamplesForLearned)
}

function confidenceForBin (bin, options) {
  if (!Number.isFinite(bin.correctionDeg)) return 0
  const sampleScore = Math.min(1, Number(bin.samples || 0) / Number(options.minSamplesForConfidence || DEFAULT_TABLE_OPTIONS.minSamplesForConfidence))
  const stddev = Number.isFinite(Number(bin.stddevDeg)) ? Number(bin.stddevDeg) : 0
  const dispersionScore = Math.max(0, 1 - stddev / Number(options.maxStddevForConfidence || DEFAULT_TABLE_OPTIONS.maxStddevForConfidence))
  const manualFloor = bin.origin === 'manual' ? 0.25 : 0
  const learnedScore = sampleScore * 0.7 + dispersionScore * 0.3
  return round(Math.max(manualFloor, Math.min(1, learnedScore)), 3)
}

function stddev (m2, effectiveSamples) {
  if (!Number.isFinite(m2) || effectiveSamples <= 1) return null
  return round(Math.sqrt(m2 / (effectiveSamples - 1)))
}

function hasCorrections (table) {
  return table.bins.some(bin => Number.isFinite(bin.correctionDeg))
}

function binIndexForHeading (headingDeg, binSize) {
  const heading = ((Number(headingDeg) % 360) + 360) % 360
  return Math.min(Math.floor(heading / binSize), binCount(binSize) - 1)
}

function isFiniteValue (value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
}

function binCount (binSize) {
  return Math.ceil(360 / binSize)
}

function normalizeOptions (options = {}) {
  const binSize = positiveNumber(options.binSize, DEFAULT_TABLE_OPTIONS.binSize)
  return {
    ...DEFAULT_TABLE_OPTIONS,
    ...options,
    binSize,
    harmonicOrder: Math.max(0, Math.floor(Number(options.harmonicOrder ?? DEFAULT_TABLE_OPTIONS.harmonicOrder)))
  }
}

function positiveNumber (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function wrapHeadingCenter (value) {
  const wrapped = value % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

function round (value, digits = 3) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

module.exports = {
  DEFAULT_TABLE_OPTIONS,
  createCorrectionTable,
  normalizeTable,
  updateTableWithObservation,
  setManualCorrection,
  resetSector,
  setSectorLocked,
  correctionForHeadingRad,
  correctionForHeadingDeg,
  summarizeTable
}
