# Signal K Compass Calibrator

Signal K plugin that calibrates a selected magnetic heading source from source-aware historical navigation data, then publishes a corrected `navigation.headingMagnetic` value as a distinct Signal K source.

## Status

Initial implementation for testing on real Signal K installations.

The calibration step currently uses a Prometheus-compatible history backend such as VictoriaMetrics. This is intentional for now: the Signal K History API does not expose the Signal K `source` label needed to calibrate one physical heading source against matching historical COG/SOG/variation data.

Use [macjl/signalk-prometheus-exporter-macjl](https://github.com/macjl/signalk-prometheus-exporter-macjl) to export source-aware Signal K data to Prometheus/VictoriaMetrics until source-aware history is available directly from Signal K.

Once a profile is accepted and activated, runtime publishing is intentionally frugal: the active correction table is compiled in memory and the plugin only publishes the corrected `navigation.headingMagnetic` value. Runtime calibration is inactive until both a saved table and a live Signal K input source are explicitly selected in the web app.

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

The plugin configuration page intentionally has no operational fields. Configuration is done in the Compass Calibrator web app:

- Prometheus/VictoriaMetrics base URL and optional basic auth.
- metric names for heading, COG, SOG, and variation.
- Signal K context, inferred from historical `navigation.magneticVariation` and selectable before calibration.
- historical source selections for heading, COG, SOG, and variation.
- saved calibration table and live Signal K input source for runtime publishing.

Speeds are shown in knots in the web app. Final calibration samples are fetched at a fixed 1-second resolution from useful navigation sub-periods selected by the adaptive calibration algorithm.

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

GitHub Actions uses the shared Signal K plugin CI workflow to validate the package on pushes and pull requests.

The CI workflow also runs Signal K integration checks, verifies App Store packaging, validates the plugin schema, checks Node 20 compatibility for Cerbo GX/Venus OS, and simulates App Store installation with `npm install --ignore-scripts`.

## Author

Jean-Laurent Girod, [@macjl](https://github.com/macjl)

## License

Apache-2.0
