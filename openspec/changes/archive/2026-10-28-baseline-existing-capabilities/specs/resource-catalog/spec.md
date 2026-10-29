# Spec Delta

## Purpose

Provides the set of quantum resources QRB can select from, read live from IBM
Quantum and Amazon Braket, without ever submitting work to them.

## ADDED Requirements

### Requirement: Read-only provider access
The catalog SHALL only read device information (list, status, queue, calibration, properties) from providers. It MUST NOT submit, cancel or otherwise create jobs on any provider.

#### Scenario: Catalog fetch performs no execution
- **WHEN** the live catalog is fetched from IBM and Braket
- **THEN** only device listing, status, queue and calibration calls are made, and no job is created on either provider

### Requirement: Supported providers
The catalog SHALL support exactly two providers, identified as `ibm` and `braket`. Requesting no provider filter SHALL fetch both. Requesting an unknown provider id MUST fail with an error naming the unknown id and the known ids.

#### Scenario: Default fetch covers both providers
- **WHEN** the catalog is fetched without a provider filter
- **THEN** resources from both `ibm` and `braket` are returned

#### Scenario: Provider filter
- **WHEN** the catalog is fetched with provider filter `["braket"]`
- **THEN** only resources whose provider is `braket` are returned

#### Scenario: Unknown provider
- **WHEN** the catalog is fetched with provider filter `["azure"]`
- **THEN** the request fails with an error naming `azure` and listing `ibm` and `braket`

### Requirement: Only gate-based hardware QPUs
The catalog SHALL include only gate-based hardware QPUs. IBM simulators and Braket simulators MUST be excluded. Braket analog and annealing devices (QuEra Aquila, D-Wave, Xanadu) MUST be excluded, even if a price is maintained for them, so they never appear.

#### Scenario: IBM simulator excluded
- **WHEN** an IBM account can see a simulator backend
- **THEN** that backend does not appear in the catalog

#### Scenario: Braket annealer excluded
- **WHEN** Braket lists a D-Wave or QuEra device
- **THEN** that device does not appear in the catalog

### Requirement: Resource record contents
Each resource SHALL carry: resource id, provider id, hardware vendor, name, qubit count, native gate and calibration data, queue length (or unknown), pricing, provider-native status text, an operational flag, and last calibration time (or unknown). Braket resources MAY also carry provider-native calibration data.

#### Scenario: Resource fields present
- **WHEN** a resource is returned from the catalog
- **THEN** it exposes all of the fields listed above, with queue length and last calibration time allowed to be unknown

### Requirement: Last calibration time source
The last calibration time SHALL be the IBM backend properties' last-update date for IBM resources, and the device service's last-update time for Braket resources. For Braket it is therefore not a true calibration timestamp. If unavailable it SHALL be unknown.

#### Scenario: Braket last calibration time
- **WHEN** a Braket device reports a service last-update time of 2026-10-01T00:00:00Z
- **THEN** its last calibration time is 2026-10-01T00:00:00Z, even if the device was calibrated at a different moment

#### Scenario: IBM last calibration time
- **WHEN** an IBM backend's properties report a last-update date
- **THEN** that date is the resource's last calibration time

### Requirement: Candidate identifier
Each resource SHALL have a candidate id of the form `<provider_id>.<resource_id>`, where every run of one or more consecutive characters outside `A-Z a-z 0-9 _ . -` in the resource id is replaced by a single `_`.

#### Scenario: Name with a space
- **WHEN** Braket reports a device named `Aria 1`
- **THEN** its candidate id is `braket.Aria_1`

#### Scenario: Consecutive disallowed characters
- **WHEN** a resource id contains two adjacent disallowed characters, such as `a  b`
- **THEN** they collapse into one underscore, giving `a_b`

### Requirement: Operational flag
The operational flag SHALL be the provider's own operational boolean for IBM, and SHALL be true for Braket only when the device status is exactly `ONLINE`. It MUST NOT be derived by parsing IBM's status text.

#### Scenario: Braket offline device
- **WHEN** a Braket device reports status `OFFLINE`
- **THEN** its operational flag is false

#### Scenario: IBM status lookup fails
- **WHEN** the IBM status call for a backend fails
- **THEN** that resource is returned with operational false, status `unknown` and unknown queue length, and the rest of the catalog is unaffected

### Requirement: Queue length
Queue length SHALL be IBM's pending job count, or for Braket the sum of all quantum-task counts the device reports. If the lookup fails, queue length SHALL be unknown rather than failing the fetch.

#### Scenario: Braket queue lookup fails
- **WHEN** the Braket queue depth call fails for one device
- **THEN** that device is returned with unknown queue length

### Requirement: IBM multi-instance deduplication
When several IBM instances are configured (`QISKIT_IBM_INSTANCES`), the catalog SHALL query each and return one resource per backend name, keeping the sighting with the shorter queue (unknown counts as longest).

#### Scenario: Same backend in two instances
- **WHEN** backend `ibm_x` is visible in two configured instances with queues 5 and 12
- **THEN** the catalog contains one `ibm_x` resource with queue length 5

### Requirement: Unpriced Braket vendor
When a live catalog fetch includes Braket and lists a device from a vendor with no maintained price, the whole catalog fetch MUST fail with an error naming the vendor, including IBM resources requested in the same fetch.

#### Scenario: Unknown vendor without provider filter
- **WHEN** a live fetch with no provider filter finds a Braket device from an unpriced vendor
- **THEN** the fetch fails with an error naming the vendor and no resources are returned, IBM included

### Requirement: Unreachable Braket region tolerated
If the device search in one Braket region fails with a service client error (for example access denied), the catalog SHALL skip that region and return devices from the others. Other kinds of error are not tolerated.

#### Scenario: One region errors
- **WHEN** the device search in one Braket region fails with a service client error
- **THEN** devices from the remaining regions are still returned

### Requirement: Per-provider catalog cache
In a long-running process, each provider's complete catalog SHALL be cached for `QRB_CATALOG_CACHE_SECONDS` (default 90 s, read once at process start).

#### Scenario: Cache hit within TTL
- **WHEN** the catalog is fetched twice within 90 seconds without forced refresh
- **THEN** the second fetch is served from the cache and reports a cache hit

### Requirement: Forced refresh
A forced refresh MUST bypass the cache read and MUST repopulate the cache with the fresh result.

#### Scenario: Forced refresh repopulates
- **WHEN** a forced refresh is requested and then a normal fetch follows within the TTL
- **THEN** the forced fetch reports a miss, and the following fetch is a cache hit with the forced fetch's data

### Requirement: Partial fetches never cached
A fetch restricted to specific resource ids SHALL bypass the cache for both reading and writing, so a partial catalog is never served to other callers.

#### Scenario: Filtered fetch
- **WHEN** a fetch restricted to resource ids `{"ibm_x"}` is made
- **THEN** it does not read from the cache and does not replace the cached full catalog

### Requirement: Freshness metadata
A live fetch SHALL report whether every requested provider was served from cache, and when the data was fetched. With several providers, the fetch time SHALL be the oldest provider's. A snapshot read SHALL report neither.

#### Scenario: Mixed freshness
- **WHEN** IBM is served from a cache filled 60 s ago and Braket is fetched live
- **THEN** the result reports cache hit false and a fetch time of 60 s ago

#### Scenario: Snapshot read
- **WHEN** the catalog is read from a snapshot
- **THEN** cache hit and fetch time are both reported as not applicable
