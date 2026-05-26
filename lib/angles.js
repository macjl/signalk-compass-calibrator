'use strict'

const TAU = Math.PI * 2

function wrap360Rad (value) {
  const wrapped = value % TAU
  return wrapped < 0 ? wrapped + TAU : wrapped
}

function wrap180Rad (value) {
  const wrapped = (value + Math.PI) % TAU
  return (wrapped < 0 ? wrapped + TAU : wrapped) - Math.PI
}

function wrap360Deg (value) {
  const wrapped = value % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

function wrap180Deg (value) {
  const wrapped = (value + 180) % 360
  return (wrapped < 0 ? wrapped + 360 : wrapped) - 180
}

function radToDeg (value) {
  return value * 180 / Math.PI
}

function degToRad (value) {
  return value * Math.PI / 180
}

function circularMeanDeg (values) {
  if (!values.length) return null
  let sin = 0
  let cos = 0
  for (const value of values) {
    const radians = degToRad(value)
    sin += Math.sin(radians)
    cos += Math.cos(radians)
  }
  if (sin === 0 && cos === 0) return 0
  return wrap180Deg(radToDeg(Math.atan2(sin / values.length, cos / values.length)))
}

function angularStddevDeg (values, meanDeg = circularMeanDeg(values)) {
  if (!values.length || meanDeg === null) return null
  const variance = values.reduce((sum, value) => {
    const diff = wrap180Deg(value - meanDeg)
    return sum + diff * diff
  }, 0) / values.length
  return Math.sqrt(variance)
}

function interpolateCircularDeg (fromDeg, toDeg, fraction) {
  return wrap180Deg(fromDeg + wrap180Deg(toDeg - fromDeg) * fraction)
}

module.exports = {
  TAU,
  wrap360Rad,
  wrap180Rad,
  wrap360Deg,
  wrap180Deg,
  radToDeg,
  degToRad,
  circularMeanDeg,
  angularStddevDeg,
  interpolateCircularDeg
}
