'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { degToRad, radToDeg, wrap180Deg, wrap360Deg } = require('../lib/angles')
const {
  calibrate,
  compileCalibrationProfile,
  correctionForCompiledProfile
} = require('../lib/calibration')

test('wrap helpers keep angles in expected ranges', () => {
  assert.equal(wrap360Deg(-10), 350)
  assert.equal(wrap360Deg(370), 10)
  assert.equal(wrap180Deg(190), -170)
  assert.equal(wrap180Deg(-190), 170)
})

test('calibration creates a candidate profile from aligned source series', () => {
  const input = makeSeries({ headingOffsetDeg: 5 })
  const profile = calibrate(input, {
    range: {
      from: new Date(0).toISOString(),
      to: new Date(35_000).toISOString()
    },
    sources: {
      heading: 'heading-a',
      cog: 'gps-a',
      sog: 'gps-a',
      variation: 'derived'
    },
    filters: {
      minSog: 1,
      maxCogRate: 10,
      minSamplesPerBin: 1,
      binSize: 30
    }
  })

  assert.equal(profile.state, 'candidate')
  assert.equal(profile.quality.sampleCount, 12)
  assert.ok(profile.quality.usableBinCount >= 10)
  assert.equal(profile.sources.heading, 'heading-a')

  const bin = profile.correctionTable.find(item => item.samples > 0)
  assert.ok(bin)
  assert.ok(Math.abs(bin.correctionDeg + 5) < 0.001)
})

test('runtime correction interpolates circular profile corrections', () => {
  const profile = {
    id: 'runtime-test',
    sources: { heading: 'heading-a' },
    correctionTable: [
      { headingDeg: 350, correctionDeg: 10, quality: 'good' },
      { headingDeg: 10, correctionDeg: -10, quality: 'good' }
    ]
  }

  const compiled = compileCalibrationProfile(profile)
  assert.equal(compiled.id, 'runtime-test')
  assert.equal(compiled.source, 'heading-a')
  assert.equal(compiled.headingsRad.length, 2)

  const correction = radToDeg(correctionForCompiledProfile(compiled, degToRad(0)))
  assert.ok(Math.abs(correction) < 0.001)
})

test('slow samples are rejected', () => {
  const input = makeSeries({ headingOffsetDeg: 3, sog: 0.2 })
  const profile = calibrate(input, {
    filters: {
      minSog: 1,
      maxCogRate: 10,
      minSamplesPerBin: 1,
      binSize: 30
    }
  })

  assert.equal(profile.quality.sampleCount, 0)
  assert.equal(profile.rejected.slow, 12)
})

function makeSeries ({ headingOffsetDeg = 0, sog = 3 }) {
  const heading = []
  const cog = []
  const speedOverGround = []
  const variation = []

  for (let index = 0; index < 12; index += 1) {
    const headingDeg = index * 30
    const t = index * 1000
    heading.push({ t, value: degToRad(headingDeg + headingOffsetDeg) })
    cog.push({ t, value: degToRad(headingDeg) })
    speedOverGround.push({ t, value: sog })
    variation.push({ t, value: 0 })
  }

  return {
    heading,
    cog,
    sog: speedOverGround,
    variation
  }
}
