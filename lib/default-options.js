'use strict'

const PUBLISH_PATH = 'navigation.headingMagnetic'

const INPUT_PATHS = {
  heading: 'navigation.headingMagnetic',
  cog: 'navigation.courseOverGroundTrue',
  sog: 'navigation.speedOverGround',
  variation: 'navigation.magneticVariation',
  state: 'navigation.state'
}

const DEFAULT_OPTIONS = {
  enabled: true,
  context: 'vessels.self',
  filters: {
    minSog: 1.5,
    maxCogRate: 2,
    maxHeadingRate: 2,
    maxSampleSkewSeconds: 2,
    maxSampleAgeSeconds: 3,
    requireMotoringStateForLearning: true,
    startupDelaySeconds: 30
  },
  table: {
    binSize: 10,
    harmonicOrder: 3,
    manualWeight: 5,
    minSamplesForLearned: 20,
    minSamplesForConfidence: 30,
    maxStddevForConfidence: 8
  },
  publishing: {
    path: PUBLISH_PATH,
    staleAfterSeconds: 10
  },
  learning: {
    saveIntervalSeconds: 60
  }
}

module.exports = {
  DEFAULT_OPTIONS,
  INPUT_PATHS,
  PUBLISH_PATH
}
