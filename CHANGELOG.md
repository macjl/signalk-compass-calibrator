# Changelog

## [0.3.2] - 2026-08-04

### Changed

- Subscribe to `navigation.state` and, when available, learn only while it reports `motoring`.
- Recommend `@meri-imperiumi/signalk-autostate` as a companion plugin.

## [0.3.1] - 2026-08-04

### Fixed

- Require magnetic variation for learning without rejecting it when it is older than HDG, COG, and SOG samples.

## [0.3.0] - 2026-08-04

### Changed

- Rework the plugin around live heading correction learning instead of historical batch calibration.
- Always publish `navigation.headingMagnetic`; an empty table applies a neutral correction.
- Use Signal K preferred-source subscriptions with `excludeSelf: true` to follow source priorities without feedback loops.
- Replace saved batch profiles with one compact live correction table supporting import, export, reset, manual sector values, and sector locking.
- Smooth corrections with circular harmonic fitting.
- Reject learning samples when input timestamps are not aligned or magnetic heading changes too fast.

### Removed

- Remove Prometheus/VictoriaMetrics historical discovery and batch calibration.

## [0.2.0] - 2026-05-27

Initial public release.

### Added

- Signal K plugin and embeddable admin webapp for magnetic heading calibration.
- Historical source discovery from Prometheus/VictoriaMetrics data.
- Batch calibration workflow with navigation period selection, stable COG filtering, coverage review, and correction table generation.
- Saved calibration table management and runtime activation.
- Frugal runtime correction publishing to `navigation.headingMagnetic`.
- Shared Signal K plugin CI workflow.
