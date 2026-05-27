# Signal K Compass Calibrator

Signal K plugin that calibrates a selected magnetic heading source from source-aware historical navigation data, then publishes a corrected `navigation.headingMagnetic` value as a distinct Signal K source.

## Status

Initial implementation for testing on real Signal K installations.

The calibration step uses a Prometheus-compatible history backend such as VictoriaMetrics. Once a profile is accepted and activated, runtime publishing is intentionally frugal: the active correction table is compiled in memory and the plugin only publishes the corrected `navigation.headingMagnetic` value.

## Features

- Select one raw magnetic heading source to calibrate.
- Select COG, SOG, and magnetic variation reference sources.
- Discover historical sources through Prometheus/VictoriaMetrics labels.
- Run explicit batch calibration over a selected time range, with coarse preselection of useful moving periods, 1-second boundary refinement, and stable COG sub-segment selection.
- Review timelines, zoomed navigation periods, radial heading coverage, correction bins, adaptive per-period thresholds, quality metrics, warnings, and a labelled correction plot.
- Save or discard candidate tables, view/delete saved tables, and select the runtime table and live Signal K input source separately.
- Publish only the corrected heading at runtime on `navigation.headingMagnetic`.
- Avoid feedback loops by ignoring the plugin's own Signal K source.

## Installation

From a Signal K server environment:

```sh
npm install github:macjl/signalk-compass-calibrator
```

Then enable the plugin from the Signal K plugin configuration UI.

After restarting Signal K, open the app from the Admin UI Web Apps menu. It is registered as an embeddable webapp, so the Signal K admin navigation stays visible while the calibrator runs in the content area.

## Configuration

The plugin exposes settings for:

- Prometheus/VictoriaMetrics base URL.
- Signal K context, inferred from `navigation.magneticVariation` by the web app when possible.
- metric names for heading, COG, SOG, and variation.
- source selections.
- calibration filters, used as defaults before adaptive per-period thresholds are computed. Speeds are shown in knots in the web app; final calibration samples are fetched at a fixed 1-second resolution.
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

GitHub Actions runs the same test suite on Node 20, 22, and 24, checks JavaScript syntax, and verifies the npm package contents with `npm pack --dry-run`.

## Author

Jean-Laurent Girod, [@macjl](https://github.com/macjl)

## License

Apache-2.0
