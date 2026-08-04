# Signal K Compass Calibrator

Signal K plugin that learns an empirical magnetic heading correction while underway and always republishes `navigation.headingMagnetic` as its own Signal K source.

## Status

Experimental live-learning rewrite for onboard testing.

This plugin does not perform a 3D magnetometer calibration. It learns a heading-dependent correction from the live relationship between magnetic heading, magnetic variation, COG, and SOG. Signal K source priorities decide whether downstream consumers use the raw heading source or this plugin's corrected heading.

## Features

- Always publishes `navigation.headingMagnetic`.
- Uses a neutral correction by default, so output heading equals input heading until learning or manual values exist.
- Uses Signal K preferred-source subscriptions with `excludeSelf: true`, so the plugin follows the user's source priorities while avoiding feedback from its own output.
- Learning mode can be enabled or disabled without disabling publication.
- Learns compact per-heading-sector statistics without storing raw samples forever.
- Tracks sample count, effective sample weight, dispersion, confidence, origin, and lock state per sector.
- Supports manual sector values, sector reset, sector lock/unlock, full table reset, and JSON import/export.
- Smooths the table with circular harmonic fitting.

## Installation

From a Signal K server environment:

```sh
npm install github:macjl/signalk-compass-calibrator
```

Then enable the plugin from the Signal K plugin configuration UI.

After restarting Signal K, open the app from the Admin UI Web Apps menu.

## Operation

Publication is always active when the plugin is enabled. If the table is empty, the published value is neutral:

```text
published HDG = source HDG
```

Enable learning only when underway in suitable conditions. The plugin rejects learning samples while inputs are missing, HDG/COG/SOG are stale or not timestamp-aligned, SOG is below the threshold, COG/HDG is unstable, or `navigation.state` is available and does not report `motoring`. Magnetic variation must be present, but it does not need to be refreshed frequently. These learning filters are exposed in the plugin configuration with conservative defaults.

When sailing, side force from the wind can create significant leeway, so the boat's heading and its course over ground may differ even when the compass is correct. This leeway is much smaller or absent when motoring, making COG a more reliable reference for learning heading correction.

The plugin works well with [`@meri-imperiumi/signalk-autostate`](https://github.com/meri-imperiumi/signalk-autostate), which can publish `navigation.state` as `sailing`, `motoring`, `moored`, or `anchored`.

Default runtime output:

```text
navigation.headingMagnetic
```

Default Signal K output source:

```text
compass-calibrator
```

## Development

```sh
npm test
```

## Author

Jean-Laurent Girod, [@macjl](https://github.com/macjl)

## License

Apache-2.0
