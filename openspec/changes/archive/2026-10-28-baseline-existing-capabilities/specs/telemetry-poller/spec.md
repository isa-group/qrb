# Spec Delta

## Purpose

Samples the live catalog on a fixed interval and records queue, status and
calibration data over time, independently of any selection request.

## ADDED Requirements

### Requirement: Periodic sampling
The poller SHALL fetch the live catalog from all providers, without forcing a refresh and therefore subject to the catalog cache (see the resource-catalog capability), and record one telemetry sample immediately at startup, then wait `QRB_POLLER_INTERVAL_SECONDS` (default 900 s) after each sample finishes and repeat, until stopped.

#### Scenario: Default interval
- **WHEN** the poller starts without `QRB_POLLER_INTERVAL_SECONDS`
- **THEN** it records a sample immediately and then waits 900 seconds after each sample finishes before the next one

#### Scenario: Overridden interval
- **WHEN** `QRB_POLLER_INTERVAL_SECONDS` is set to a number (fractions allowed)
- **THEN** the poller waits that many seconds after each sample finishes before the next one

#### Scenario: Invalid interval
- **WHEN** `QRB_POLLER_INTERVAL_SECONDS` is not a number
- **THEN** the poller exits at startup with an error and records nothing

#### Scenario: Interval shorter than the catalog cache
- **WHEN** `QRB_POLLER_INTERVAL_SECONDS` is shorter than the 90 s per-provider catalog cache lifetime
- **THEN** a tick may be served cached catalog data, so it can record the same values again under a new sample time

#### Scenario: Negative, infinite or NaN interval
- **WHEN** `QRB_POLLER_INTERVAL_SECONDS` is a negative number, infinity or NaN
- **THEN** the poller records the first sample and then exits with an error instead of waiting

### Requirement: Failures do not stop the poller
If fetching the catalog or recording a sample fails, the poller SHALL log the error and try again at the next interval.

#### Scenario: Provider outage
- **WHEN** the catalog fetch fails during one tick
- **THEN** the error is logged, no sample is recorded for that tick, and the poller samples again after the interval

### Requirement: Tick contents
Each tick SHALL record one telemetry sample of every resource in the live catalog, with row contents as defined by the history-persistence capability.

#### Scenario: Sample recorded
- **WHEN** one tick completes with 12 resources
- **THEN** a sample of those 12 resources is recorded and the count 12 is logged

#### Scenario: No database configured
- **WHEN** `DATABASE_URL` is not set and a tick completes
- **THEN** nothing is stored, yet the poller still logs the resource count as recorded and continues

### Requirement: Settings loaded from .env
The poller SHALL load settings from a `.env` file found by searching upward from its installed package location (the repo root in a workspace install), not from the working directory; already-set environment variables take precedence.

#### Scenario: Environment overrides file
- **WHEN** `QRB_POLLER_INTERVAL_SECONDS` is set both in the environment and in the `.env` file
- **THEN** the environment value is used
