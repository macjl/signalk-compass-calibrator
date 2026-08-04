'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createCorrectionTable,
  updateTableWithObservation,
  setManualCorrection,
  setSectorLocked,
  correctionForHeadingDeg,
  summarizeTable
} = require('../lib/correction-table')

test('empty table applies a neutral correction', () => {
  const table = createCorrectionTable({ binSize: 10 })

  assert.equal(correctionForHeadingDeg(table, 123), 0)
  assert.equal(summarizeTable(table).usableBinCount, 0)
})

test('observations update the matching heading sector with online dispersion', () => {
  let table = createCorrectionTable({ binSize: 10, harmonicOrder: 0 })

  table = updateTableWithObservation(table, { headingDeg: 42, correctionDeg: -4 })
  table = updateTableWithObservation(table, { headingDeg: 45, correctionDeg: -6 })

  const bin = table.bins[4]
  assert.equal(bin.samples, 2)
  assert.equal(bin.origin, 'learned')
  assert.ok(Math.abs(bin.correctionDeg + 5) < 0.001)
  assert.ok(bin.stddevDeg > 0)
})

test('manual unlocked correction is progressively forgotten by learning', () => {
  let table = createCorrectionTable({
    binSize: 10,
    harmonicOrder: 0,
    manualWeight: 5,
    minSamplesForLearned: 6
  })

  table = setManualCorrection(table, 40, 10)
  table = setSectorLocked(table, 40, false)

  for (let index = 0; index < 20; index += 1) {
    table = updateTableWithObservation(table, { headingDeg: 42, correctionDeg: -5 })
  }

  const bin = table.bins[4]
  assert.equal(bin.locked, false)
  assert.equal(bin.origin, 'learned')
  assert.ok(bin.correctionDeg < 0)
  assert.ok(Math.abs(bin.correctionDeg + 2) < 1)
})

test('locked sector contributes but is not updated by learning', () => {
  let table = createCorrectionTable({ binSize: 10, harmonicOrder: 1 })
  table = setManualCorrection(table, 40, 8)
  const before = table.bins[4].correctionDeg

  table = updateTableWithObservation(table, { headingDeg: 42, correctionDeg: -8 })

  const bin = table.bins[4]
  assert.equal(bin.locked, true)
  assert.equal(bin.samples, 0)
  assert.equal(bin.correctionDeg, before)
  assert.ok(Number.isFinite(bin.smoothedCorrectionDeg))
})

test('clustered sparse manual sectors do not trigger global harmonic oscillation', () => {
  let table = createCorrectionTable({ binSize: 10, harmonicOrder: 3 })

  table = setManualCorrection(table, 0, -3.85)
  table = setManualCorrection(table, 10, -4.28)
  table = setManualCorrection(table, 20, -12.67)

  assert.equal(table.harmonics.fitted, true)
  assert.ok(Math.abs(correctionForHeadingDeg(table, 185)) < 1)
  assert.ok(Math.abs(correctionForHeadingDeg(table, 275)) < 1)
  assert.ok(Math.abs(correctionForHeadingDeg(table, 305)) < 2)
})

test('empty sectors constrain harmonic fitting with weak zero corrections', () => {
  let table = createCorrectionTable({ binSize: 10, harmonicOrder: 3 })
  const corrections = new Map([
    [15, -0.267],
    [25, -13.678],
    [35, -13.247],
    [55, -16.2],
    [75, -14.525],
    [85, -0.071],
    [105, -5.701],
    [115, -3.973],
    [125, -11.3],
    [135, -9.8],
    [145, -8.714],
    [165, -6.4],
    [175, 4.646],
    [185, 0.95],
    [195, 5.9],
    [225, 8.963]
  ])

  for (const [headingDeg, correctionDeg] of corrections) {
    table = updateTableWithObservation(table, { headingDeg, correctionDeg })
  }

  assert.equal(table.harmonics.fitted, true)
  assert.equal(table.bins[0].origin, 'empty')
  assert.equal(table.bins[30].origin, 'empty')
  assert.ok(Math.abs(table.bins[0].smoothedCorrectionDeg) < 3)
  assert.ok(Math.abs(table.bins[30].smoothedCorrectionDeg) < 1)
  assert.ok(Math.abs(table.bins[35].smoothedCorrectionDeg) < 3)
  assert.ok(Number.isFinite(table.bins[2].smoothedCorrectionDeg))
})
