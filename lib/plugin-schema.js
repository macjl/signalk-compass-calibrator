'use strict'

const { DEFAULT_OPTIONS } = require('./default-options')

function buildSchema () {
  return {
    type: 'object',
    title: 'Compass Calibrator',
    description: 'Configure live heading learning filters here. Open Webapps > Compass Calibrator to monitor learning, manage the correction table, and import or export backups.',
    properties: {
      filters: {
        type: 'object',
        title: 'Learning filters',
        default: DEFAULT_OPTIONS.filters,
        properties: {
          minSog: {
            type: 'number',
            title: 'Minimum SOG',
            description: 'Minimum speed over ground in m/s required for accepting learning samples.',
            default: DEFAULT_OPTIONS.filters.minSog
          },
          maxCogRate: {
            type: 'number',
            title: 'Maximum COG rate',
            description: 'Maximum course over ground change rate in degrees per second accepted for learning.',
            default: DEFAULT_OPTIONS.filters.maxCogRate
          },
          maxHeadingRate: {
            type: 'number',
            title: 'Maximum heading rate',
            description: 'Maximum magnetic heading change rate in degrees per second accepted for learning.',
            default: DEFAULT_OPTIONS.filters.maxHeadingRate
          },
          maxSampleSkewSeconds: {
            type: 'number',
            title: 'Maximum input timestamp skew',
            description: 'Maximum timestamp difference in seconds allowed between HDG, COG, and SOG samples.',
            default: DEFAULT_OPTIONS.filters.maxSampleSkewSeconds
          },
          maxSampleAgeSeconds: {
            type: 'number',
            title: 'Maximum sample age',
            description: 'Maximum age in seconds allowed for HDG, COG, and SOG samples. Magnetic variation must be present but does not need to be recent.',
            default: DEFAULT_OPTIONS.filters.maxSampleAgeSeconds
          },
          requireMotoringStateForLearning: {
            type: 'boolean',
            title: 'Require motoring state for learning',
            description: 'When navigation.state is available, accept learning samples only while it equals motoring. Publishing remains active in all states.',
            default: DEFAULT_OPTIONS.filters.requireMotoringStateForLearning
          },
          startupDelaySeconds: {
            type: 'number',
            title: 'Startup delay',
            description: 'Delay in seconds after plugin start before learning samples may be accepted.',
            default: DEFAULT_OPTIONS.filters.startupDelaySeconds
          }
        }
      }
    }
  }
}

module.exports = {
  buildSchema
}
