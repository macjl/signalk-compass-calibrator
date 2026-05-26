# Signal K Compass Calibrator Plugin Specification

## Context

The goal is to build a Signal K plugin that calibrates a magnetic heading source using historical navigation data, then publishes a corrected heading back into Signal K.

The immediate implementation should use Prometheus-compatible historical metrics, such as VictoriaMetrics, because the current Signal K History API does not expose source information. Once Signal K History API supports source-aware historical data, the plugin should be adapted to use it through a replaceable history provider abstraction.

This plugin targets a real-world case where a vessel may have:

- multiple magnetic heading sources;
- multiple GPS sources providing COG/SOG;
- multiple magnetic variation sources;
- different freshness and reliability across sources.

For calibration, source identity is essential. The plugin must calibrate one selected physical heading device against selected reference sources.

## High-Level Goal

Create a Signal K plugin, tentatively named `signalk-compass-calibrator`, that:

- discovers available sources for the required navigation paths;
- lets the user select the heading source to calibrate;
- lets the user select the COG, SOG, and magnetic variation reference sources;
- runs an explicit batch calibration over a user-selected historical time range;
- displays the computed calibration profile and its quality;
- lets the user accept or reject the profile;
- applies the accepted active profile in real time;
- publishes the calibrated heading on `navigation.headingMagnetic` as a distinct Signal K source.

## Important Design Decisions

### Calibration Is Batch-Based

The plugin should not continuously learn or modify calibration in the background.

Calibration is an explicit user action:

1. User opens the plugin web UI.
2. User verifies and selects sources.
3. User selects a historical time range.
4. User adjusts filters and thresholds.
5. User runs calibration.
6. Plugin computes a candidate profile.
7. User reviews quality and correction table.
8. User accepts and activates the profile, or rejects it.

This avoids silently learning from poor data, current, leeway, manoeuvres, harbour movement, or stale sources.

### Publish On Native Signal K Path

The plugin should publish the calibrated value on:

```text
navigation.headingMagnetic
```

It must publish as a distinct source, for example:

```text
signalk-compass-calibrator
```

This is intentional. With the newer Signal K source priority/trust model, the calibrated plugin source can be selected as the trusted source while the raw heading sources remain available.

The plugin must not overwrite or hide raw source data. It simply contributes another source for the same path.

### Avoid Feedback Loops

The plugin must never use its own published `navigation.headingMagnetic` as input.

It must:

- only read the configured raw heading source;
- ignore updates whose `$source` is the plugin itself;
- publish with a stable dedicated `$source`;
- stop publishing if the configured raw source disappears or becomes stale.

## Data Inputs

Required input paths:

```text
navigation.headingMagnetic
navigation.courseOverGroundTrue
navigation.speedOverGround
navigation.magneticVariation
```

Optional but strongly useful paths:

```text
navigation.rateOfTurn
navigation.position
navigation.speedThroughWater
navigation.leewayAngle
navigation.magneticVariationAgeOfService
```

Prometheus/VictoriaMetrics metric names may be derived from Signal K paths, for example:

```text
navigation_headingMagnetic
navigation_courseOverGroundTrue
navigation_speedOverGround
navigation_magneticVariation
navigation_rateOfTurn
navigation_position_latitude
navigation_position_longitude
```

Expected labels:

```text
context
source
job
instance
```

The `source` label is required for source-aware calibration.

## Source Selection

The plugin UI must allow source selection separately for each logical input:

- heading source to calibrate;
- COG source;
- SOG source;
- magnetic variation source.

COG and SOG should usually come from the same GPS source, but the plugin should not hard-code that. It should warn if the selected COG and SOG sources differ.

The UI should show for each metric/source pair:

- source id;
- sample count in selected range;
- first sample timestamp;
- last sample timestamp;
- latest value;
- coverage percentage over the selected range;
- stale/current status when inspecting live data.

## Historical Data Strategy

### Initial Implementation

Use Prometheus-compatible APIs:

```text
/api/v1/label/<label>/values
/api/v1/query
/api/v1/query_range
```

The initial target can be VictoriaMetrics, but the plugin should keep the implementation generic enough for Prometheus-compatible APIs where possible.

Queries must filter by:

```text
context="<vessel context>"
source="<selected source>"
```

Example selector:

```text
navigation_headingMagnetic{context="vessels.urn:mrn:imo:mmsi:227406160",source="Can0.c050a008e8331bf1"}
```

### Future Implementation

Introduce a history provider abstraction:

```text
HistoryProvider
  listSources(path, range)
  getSeries(path, source, range, resolution)
  getCoverage(path, source, range)
```

Initial provider:

```text
PrometheusHistoryProvider
```

Future provider:

```text
SignalKHistoryProvider
```

When Signal K History API becomes source-aware, only the provider should need replacement.

## Calibration Algorithm

For each aligned historical sample:

```text
heading_true = heading_magnetic + magnetic_variation
error = wrap180(heading_true - course_over_ground_true)
correction = -error
```

Units:

- Signal K angles are radians.
- Prometheus metrics should be assumed to preserve Signal K units unless proven otherwise.
- UI should display degrees.
- SOG is in m/s.

The correction table should be keyed by raw magnetic heading.

### Angle Wrapping

Use circular math:

```text
wrap360(x) = x modulo 360
wrap180(x) = ((x + 540) modulo 360) - 180
```

Do not average headings with ordinary arithmetic when crossing 0/360. Use circular mean where relevant.

## Filtering

The plugin must filter aggressively before accepting samples.

Minimum filters:

- SOG above threshold, for example `minSog = 1.5 m/s`;
- valid heading, COG, SOG, and magnetic variation at the same timestamp;
- no large timestamp gaps;
- minimum segment duration;
- COG stability over a rolling window;
- heading stability or low rate of turn;
- minimum sample count per heading bin.

Optional filters:

- `navigation.rateOfTurn` below threshold;
- exclude samples during acceleration or deceleration;
- compare reciprocal courses to reduce current/leeway bias;
- exclude periods where COG and heading diverge too much;
- use speed through water and leeway if reliable.

The UI must make these filters visible and editable.

## Binning And Profile Generation

The user should be able to choose bin size:

```text
5 deg
10 deg
15 deg
30 deg
```

Default recommendation:

```text
10 deg
```

For each bin:

- heading range;
- sample count;
- mean error;
- median error if implemented;
- standard deviation;
- correction value;
- quality status.

Bins with insufficient samples should be marked unreliable and not blindly used.

Possible bin quality states:

```text
good
weak
missing
rejected
```

The profile may interpolate between reliable bins, but interpolation must be visible to the user.

Runtime correction should use circular interpolation between heading bins.

## Profile Lifecycle

A calibration profile should have explicit state:

```text
candidate
saved
active
archived
rejected
```

Meaning:

- `candidate`: just calculated, not active;
- `saved`: stored for later, not active;
- `active`: used by runtime publishing;
- `archived`: old profile no longer active;
- `rejected`: discarded or retained only for audit.

Activating a profile should:

- mark previous active profile as archived or saved;
- store the new profile as active;
- start or update runtime correction;
- record the active source selections and filters used to create it.

## Profile Data Model

Example profile:

```json
{
  "id": "2026-05-25-can0-heading-main",
  "createdAt": "2026-05-26T10:30:00Z",
  "state": "active",
  "range": {
    "from": "2026-05-24T09:00:00Z",
    "to": "2026-05-25T09:00:00Z"
  },
  "sources": {
    "heading": "Can0.c050a008e8331bf1",
    "cog": "signalk-fallback",
    "sog": "signalk-fallback",
    "variation": "derived-data"
  },
  "filters": {
    "minSog": 1.5,
    "maxRateOfTurn": 0.5,
    "maxCogRate": 1.0,
    "binSize": 10,
    "minSamplesPerBin": 10
  },
  "quality": {
    "sampleCount": 842,
    "usableBinCount": 27,
    "coverageDeg": 270,
    "meanErrorDeg": 3.2,
    "stddevDeg": 2.1
  },
  "correctionTable": [
    {
      "headingDeg": 0,
      "correctionDeg": -3.1,
      "samples": 18,
      "quality": "good"
    },
    {
      "headingDeg": 10,
      "correctionDeg": -3.4,
      "samples": 22,
      "quality": "good"
    }
  ]
}
```

## Runtime Behavior

When enabled and an active profile exists:

1. Subscribe to live `navigation.headingMagnetic`.
2. Select only the configured raw source.
3. Ignore plugin's own source.
4. Compute correction for the raw heading using the active profile.
5. Publish corrected heading to `navigation.headingMagnetic` as plugin source.

Formula:

```text
heading_calibrated = wrap360(heading_raw + correction_for_heading)
```

The plugin should publish in radians.

Example delta:

```json
{
  "updates": [
    {
      "$source": "signalk-compass-calibrator",
      "values": [
        {
          "path": "navigation.headingMagnetic",
          "value": 1.642
        }
      ]
    }
  ]
}
```

## Runtime Diagnostics

The plugin should publish diagnostic paths under a plugin-specific namespace, for example:

```text
navigation.headingMagneticCalibration.raw
navigation.headingMagneticCalibration.correction
navigation.headingMagneticCalibration.profileId
navigation.headingMagneticCalibration.inputSource
navigation.headingMagneticCalibration.status
navigation.headingMagneticCalibration.quality
```

These paths help the user understand what the plugin is doing without inspecting logs.

Possible runtime statuses:

```text
inactive
active
noProfile
missingInput
staleInput
outsideReliableRange
publishing
error
```

## Web UI Requirements

The plugin should include a web UI with at least four sections.

### Sources

Purpose:

- discover available live and historical sources;
- show source coverage;
- let the user select sources.

Controls:

- context selector;
- history backend URL;
- time range for discovery;
- source table;
- source selection controls.

### Calibration

Purpose:

- configure and run batch calibration.

Controls:

- from/to date-time selectors;
- resolution;
- min SOG;
- max rate of turn;
- max COG rate;
- bin size;
- min samples per bin;
- run calibration button.

### Profile Review

Purpose:

- inspect candidate profile before activation.

Display:

- sample count;
- angular coverage;
- usable bins;
- mean error;
- standard deviation;
- correction table;
- polar or circular plot;
- warnings for missing sectors.

Actions:

- save;
- reject;
- activate.

### Runtime

Purpose:

- show current active profile and live correction.

Display:

- active profile id;
- selected raw source;
- last raw heading;
- last correction;
- last calibrated heading;
- publish status;
- stale/missing input warnings.

## Quality And Warnings

The plugin should warn when:

- angular coverage is poor;
- too few bins are reliable;
- COG/SOG sources differ;
- selected variation source is stale;
- selected heading source is stale;
- computed standard deviation is high;
- profile depends heavily on interpolation;
- no reciprocal courses are present;
- runtime input source differs from the profile source.

The plugin should not prevent activation unless the profile is structurally invalid, but it should make poor calibration quality obvious.

## Storage

The plugin should persist:

- plugin configuration;
- source selections;
- historical backend settings;
- saved profiles;
- active profile id;
- last calibration report.

Use Signal K plugin settings storage where appropriate. Profiles may be stored as JSON inside plugin-specific storage.

## Configuration Shape

Example configuration:

```json
{
  "enabled": true,
  "prometheus": {
    "baseUrl": "http://victoriametrics:8428",
    "type": "victoriametrics",
    "auth": null
  },
  "context": "vessels.self",
  "metrics": {
    "headingMagnetic": "navigation_headingMagnetic",
    "courseOverGroundTrue": "navigation_courseOverGroundTrue",
    "speedOverGround": "navigation_speedOverGround",
    "magneticVariation": "navigation_magneticVariation",
    "rateOfTurn": "navigation_rateOfTurn"
  },
  "sources": {
    "heading": "Can0.c050a008e8331bf1",
    "cog": "signalk-fallback",
    "sog": "signalk-fallback",
    "variation": "derived-data"
  },
  "filters": {
    "minSog": 1.5,
    "maxRateOfTurn": 0.5,
    "maxCogRate": 1.0,
    "minSegmentDuration": 30,
    "minSamplesPerBin": 10
  },
  "calibration": {
    "binSize": 10,
    "smoothing": true,
    "interpolation": "linear-circular"
  },
  "publishing": {
    "enabled": true,
    "source": "signalk-compass-calibrator",
    "path": "navigation.headingMagnetic"
  }
}
```

## API Endpoints Exposed By Plugin

The plugin should expose HTTP endpoints for the web UI.

Suggested endpoints:

```text
GET  /plugins/compass-calibrator/api/sources
POST /plugins/compass-calibrator/api/discover
POST /plugins/compass-calibrator/api/calibrate
GET  /plugins/compass-calibrator/api/profiles
GET  /plugins/compass-calibrator/api/profiles/:id
POST /plugins/compass-calibrator/api/profiles/:id/activate
POST /plugins/compass-calibrator/api/profiles/:id/archive
DELETE /plugins/compass-calibrator/api/profiles/:id
GET  /plugins/compass-calibrator/api/runtime
```

## Non-Goals For Initial Version

The first version does not need to:

- automatically decide the best source;
- continuously learn calibration;
- write calibration back into physical instruments;
- support all history backends;
- implement complex current/leeway compensation;
- replace Signal K source priority management.

## Initial Development Strategy

Recommended implementation order:

1. Scaffold Signal K plugin with config schema and basic web UI.
2. Implement live source discovery from Signal K model.
3. Implement Prometheus/VictoriaMetrics source discovery.
4. Implement historical series fetching with source filters.
5. Implement calibration engine as a pure module with unit tests.
6. Implement candidate profile generation and JSON storage.
7. Implement profile review UI.
8. Implement activation lifecycle.
9. Implement runtime subscription and publishing to `navigation.headingMagnetic`.
10. Add diagnostics paths.
11. Add quality warnings and guardrails.
12. Later replace or complement Prometheus backend with Signal K History API provider when source-aware history is available.

## Key Acceptance Criteria

- User can select one heading source among multiple heading sources.
- User can select GPS reference source for COG/SOG.
- User can select magnetic variation source.
- Calibration uses historical data from the selected sources only.
- Candidate profile includes correction table and quality metrics.
- Profile is not used until explicitly activated.
- Runtime publishes calibrated heading to `navigation.headingMagnetic` as a distinct plugin source.
- Plugin does not use its own output as input.
- Plugin can be disabled without losing raw heading data.
- History backend is abstracted so Signal K History API can replace Prometheus later.

