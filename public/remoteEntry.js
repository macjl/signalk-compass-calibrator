(function () {
  'use strict'

  var sharedReact = null

  function resolveReact () {
    return (sharedReact && (sharedReact.default || sharedReact)) || window.React
  }

  function CompassCalibratorPanel () {
    var React = resolveReact()
    if (!React) throw new Error('React is required to render Compass Calibrator')
    return React.createElement('iframe', {
      title: 'Compass Calibrator',
      src: '/signalk-compass-calibrator/',
      style: {
        border: 0,
        display: 'block',
        height: 'calc(100vh - 92px)',
        minHeight: '720px',
        width: '100%'
      }
    })
  }

  var modules = {
    './AppPanel': function () {
      return {
        __esModule: true,
        default: CompassCalibratorPanel
      }
    }
  }

  window.signalk_compass_calibrator = {
    get: function (module) {
      if (!modules[module]) return Promise.reject(new Error('Unknown module ' + module))
      return Promise.resolve(modules[module])
    },
    init: function (shareScope) {
      var reactShare = shareScope && shareScope.react
      if (reactShare && typeof reactShare.get !== 'function') {
        var versions = Object.keys(reactShare)
        reactShare = versions.length ? reactShare[versions[0]] : null
      }
      if (reactShare && typeof reactShare.get === 'function') {
        return Promise.resolve(reactShare.get()).then(function (factory) {
          sharedReact = typeof factory === 'function' ? factory() : factory
        })
      }
      return Promise.resolve()
    }
  }
}())
