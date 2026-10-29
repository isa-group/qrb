# Spec Delta

## Purpose

Controls who may call QRB's public API and how much they may use it: callers
are identified as anonymous browser users, signed-in users or API keys, and
each identity is subject to quotas, rate limits and abuse controls that
protect the operator's provider credentials and the OpenBinding gateway.

## ADDED Requirements

### Requirement: Single public entry point
All public HTTP traffic SHALL go through the gateway. The Python API MUST NOT be reachable from outside the deployment's private network, and it MUST reject any request that does not carry the gateway's shared secret.

#### Scenario: Direct call to the Python API
- **WHEN** a request reaches the Python API without the gateway's shared secret
- **THEN** it is rejected with 401 and no catalog fetch or solve happens

#### Scenario: Call through the gateway
- **WHEN** an allowed request reaches the gateway
- **THEN** the gateway forwards it to the Python API with the shared secret and returns the Python API's status and body unchanged

### Requirement: Anonymous identity
A browser without a session SHALL receive an anonymous identity on its first request that needs one, kept in a session cookie. Anonymous identities SHALL be subject to the anonymous limits.

#### Scenario: First playground resolve
- **WHEN** a browser with no session resolves a binding in the playground
- **THEN** an anonymous identity is created, the request is counted against it, and the response sets the session cookie

### Requirement: Linking anonymous use to an account
When an anonymous user signs up or signs in, the anonymous identity SHALL be linked to the account, and usage already counted that day SHALL count toward the account's quota.

#### Scenario: Sign up after anonymous use
- **WHEN** an anonymous user who made 4 resolves today signs up
- **THEN** the new account starts the day with 4 resolves counted

### Requirement: Accounts
Users SHALL be able to sign up, sign in and sign out with GitHub or ORCID only. There SHALL be no email or password sign-in. A signed-in user SHALL be identified by a session cookie.

#### Scenario: Sign up with GitHub
- **WHEN** a user without an account completes GitHub sign-in
- **THEN** an account is created, a session cookie is set and later requests are counted against that user

#### Scenario: Sign out
- **WHEN** a signed-in user signs out
- **THEN** the session cookie is cleared and the session can no longer be used

#### Scenario: No password sign-in
- **WHEN** a client calls an email or password sign-up or sign-in route
- **THEN** the route does not exist and no account is created

### Requirement: Account merging on verified email
When a user signs in with a provider whose verified email matches the email of an existing account, the provider SHALL be linked to that account instead of creating a new one. An email the provider does not report as verified, or no email at all, MUST NOT trigger a merge.

#### Scenario: Same verified email on GitHub and ORCID
- **WHEN** a user with an account created through ORCID signs in with GitHub, and GitHub reports a verified email equal to the account's email
- **THEN** GitHub is linked to the existing account and no second account is created

#### Scenario: Unverified email
- **WHEN** a provider returns an email equal to an existing account's email but does not report it as verified
- **THEN** no merge happens and a separate account is created

#### Scenario: No email returned
- **WHEN** ORCID returns no email for the user
- **THEN** a separate account is created

### Requirement: Manual account linking
A signed-in user SHALL be able to link the other provider to their account and unlink a provider, as long as at least one provider stays linked.

#### Scenario: Link ORCID while signed in
- **WHEN** a user signed in with GitHub links their ORCID account
- **THEN** either provider signs them into the same account afterwards

#### Scenario: Unlink the last provider
- **WHEN** a user tries to unlink their only linked provider
- **THEN** the request is refused

### Requirement: API keys
A signed-in user SHALL be able to create, list and revoke API keys. A key's secret SHALL be shown only once, at creation. Requests SHALL present a key in the `x-api-key` header and are then identified as the key's owner.

#### Scenario: Create a key
- **WHEN** a signed-in user creates an API key
- **THEN** the secret is returned once and later listings show only its name, prefix and creation time

#### Scenario: Revoked key
- **WHEN** a request uses a revoked or unknown API key
- **THEN** the response is 401 and nothing is counted

### Requirement: Open routes
`GET /health`, the API reference, `GET /catalog`, `GET /catalog/{candidate_id}`, `GET /presets` and `GET /engines` SHALL be callable without any identity, subject to a per-IP rate limit.

#### Scenario: Browse without a session
- **WHEN** a client with no cookie and no API key calls `GET /catalog`
- **THEN** the catalog is returned and no identity is created

### Requirement: Resolve routes need an identity
`POST /select` and `POST /instance` SHALL require an identity: an anonymous or signed-in session, or an API key. A request with none SHALL return 401.

#### Scenario: Script without a key
- **WHEN** a client with no cookie and no API key calls `POST /select`
- **THEN** the response is 401

### Requirement: Daily resolve quota
Each user (anonymous or signed in) SHALL have a daily quota of resolve units, reset at 00:00 UTC. Each `POST /select` or `POST /instance` SHALL cost one unit. Requests made with a user's API keys SHALL draw from that user's quota. Quota sizes SHALL be configurable per tier.

#### Scenario: Keys share the owner's quota
- **WHEN** a user with a 200-unit quota spends 150 units in the browser and then 60 through an API key
- **THEN** the 51st key request of the day is rejected with 429

### Requirement: Live refresh costs more
A resolve or catalog request with `force_refresh` set SHALL cost a configurable number of units instead of one.

#### Scenario: Live refresh weight of 5
- **WHEN** the live refresh cost is 5 and a signed-in user resolves with `force_refresh: true`
- **THEN** 5 units are deducted

### Requirement: Anonymous users get the cached catalog only
A request from an anonymous identity, or from no identity, whose effective `force_refresh` is true SHALL be rejected with 403 and a `detail` saying that live refresh requires sign-in. On `POST /select` and `POST /instance` an omitted `force_refresh` is effectively true, as in the API's own default.

#### Scenario: Anonymous request omits force_refresh
- **WHEN** an anonymous user sends `POST /select` without `force_refresh`
- **THEN** the response is 403 and nothing is counted

#### Scenario: Anonymous live refresh
- **WHEN** an anonymous user sends `POST /select` with `force_refresh: true`
- **THEN** the response is 403 and nothing is counted

#### Scenario: Anonymous cached resolve
- **WHEN** an anonymous user sends `POST /select` with `force_refresh: false`
- **THEN** the request is served from the catalog cache and costs one unit

### Requirement: Per-IP cap on anonymous use
Resolves from all anonymous identities at one IP address SHALL share a daily cap, so creating new anonymous identities does not reset the limit.

#### Scenario: Cleared cookies
- **WHEN** a browser clears its cookies after reaching the per-IP anonymous cap
- **THEN** its next resolve is rejected with 429 and no new anonymous identity is created

### Requirement: Burst rate limits
Requests SHALL be limited per identity and per API key over a short window, separately from the daily quota.

#### Scenario: Runaway script
- **WHEN** one API key sends more requests within a minute than its burst limit
- **THEN** further requests in that window get 429 while the owner's other keys and browser session are unaffected by the per-key limit

### Requirement: CAPTCHA for anonymous resolves
An anonymous resolve SHALL require a valid CAPTCHA token. Signed-in users and API keys SHALL NOT need one.

#### Scenario: Missing CAPTCHA
- **WHEN** an anonymous user sends `POST /select` without a valid CAPTCHA token
- **THEN** the response is 403 and nothing is counted

### Requirement: Limit responses
A request rejected by a quota or rate limit SHALL return 429 with a `detail` naming the exceeded limit and a `Retry-After` header. Every counted request SHALL report the remaining daily quota in a response header.

#### Scenario: Quota exhausted
- **WHEN** a user with no remaining units resolves
- **THEN** the response is 429 with `Retry-After` set to the seconds until 00:00 UTC

#### Scenario: Remaining quota header
- **WHEN** a counted request succeeds
- **THEN** the response carries the remaining daily units in a header

### Requirement: Failed requests are not charged
A counted request whose forwarded call fails with a 5xx status SHALL NOT consume quota units. Requests rejected with 4xx before forwarding SHALL NOT consume units either.

#### Scenario: Solver down
- **WHEN** a signed-in user's `POST /select` returns 502 because OpenBinding is unreachable
- **THEN** no units are deducted

### Requirement: Usage endpoint
An identified caller SHALL be able to read its tier, daily quota, units used today and time until reset.

#### Scenario: Check usage
- **WHEN** a signed-in user calls the usage endpoint after 12 resolves
- **THEN** it reports 12 units used and the remaining units and reset time
