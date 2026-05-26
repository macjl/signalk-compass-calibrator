# Signal K Compass Calibrator

Signal K plugin that calibrates a selected magnetic heading source from source-aware historical navigation data, then publishes a corrected `navigation.headingMagnetic` value as a distinct Signal K source.

## Status

Initial implementation for testing on real Signal K installations.

The calibration step uses a Prometheus-compatible history backend such as VictoriaMetrics. Once a profile is accepted and activated, runtime publishing is intentionally frugal: the active correction table is compiled in memory and the plugin only publishes the corrected `navigation.headingMagnetic` value.

## Features

- Select one raw magnetic heading source to calibrate.
- Select COG, SOG, and magnetic variation reference sources.
- Discover historical sources through Prometheus/VictoriaMetrics labels.
- Run explicit batch calibration over a selected time range, with coarse preselection of useful moving periods.
- Review correction bins, selected periods, adaptive per-period thresholds, quality metrics, warnings, and a correction plot.
- Save, reject, archive, or activate profiles.
- Publish only the corrected heading at runtime on `navigation.headingMagnetic`.
- Avoid feedback loops by ignoring the plugin's own Signal K source.

## Installation

From a Signal K server environment:

```sh
npm install github:macjl/signalk-compass-calibrator
```

Then enable the plugin from the Signal K plugin configuration UI.

## Configuration

The plugin exposes settings for:

- Prometheus/VictoriaMetrics base URL.
- Signal K context, inferred from `navigation.magneticVariation` by the web app when possible.
- metric names for heading, COG, SOG, and variation.
- source selections.
- calibration filters, used as defaults before adaptive per-period thresholds are computed.
- publishing source and output path.

Default runtime output:

```text
navigation.headingMagnetic
```

Default Signal K output source:

```text
signalk-compass-calibrator
```

## Development

```sh
npm test
```

## Author

Jean-Laurent Girod, [@macjl](https://github.com/macjl)

## License

Apache-2.0
