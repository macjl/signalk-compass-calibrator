'use strict'

function buildSchema () {
  return {
    type: 'object',
    title: 'Compass Calibrator',
    description: 'This plugin is configured from the Compass Calibrator web app in the Signal K admin interface. Open Webapps > Compass Calibrator to discover historical sources, run calibration, manage saved tables, and activate or deactivate runtime publishing.',
    properties: {}
  }
}

module.exports = {
  buildSchema
}
