# M7 Release Contract Audit

Date: 2026-09-06

## Scope

This audit covers the public boundary between the source repository and the
builder repository. It verifies routing, payload minimization, revision pinning,
retry behavior, documentation ownership, and publication constraints.

Repository settings and secret values remain operational state. Tracked source
documentation records the configuration names, ownership, and behavior.

## Source-owned contract

The source repository owns exactly two dispatch configuration names:

- `LEPTONICA_BUILDER_REPOSITORY`, containing the builder route as
  `owner/repository`;
- `LEPTONICA_BUILDER_DISPATCH_TOKEN`, authorizing repository dispatch.

A configured route activates dispatch. The workflow validates both the route
shape and the token before sending the event.

The public payload schema consists exactly of contract version, exact source
revision, immutable release ID, and the canonical public manifest. Private
variant configuration remains within the source-owned release-set resolver.

## Builder-owned contract

The builder owns its complete environment and secret inventory, source access,
candidate materialization, promotion identities, and provisioning procedure.
`leptonica-builder/docs/candidate-transport.md` is the canonical operational
guide, and the source contract delegates builder setup to it.

## Verification matrix

| Concern | Evidence | Result |
| --- | --- | --- |
| Dispatch gate | `main` push plus configured builder route | Pass |
| Route validation | Builder route must match `owner/repository` | Pass |
| Credential validation | Configured route requires a non-empty token | Pass |
| Public payload | Four public fields only | Pass |
| Public schema boundary | Payload consists exactly of the four public fields | Pass |
| Source verification | Builder checks out and verifies the exact source revision | Pass |
| Required outputs | `leptonica.wasm`, `leptonica.mjs`, and `build-info.json` | Pass |
| Retry classification | Transport errors, HTTP 429, and transient HTTP 5xx retry with backoff | Pass |
| Non-retryable failure | Other HTTP failures fail immediately with diagnostics | Pass |
| Publication channel | GitHub Release is the sole publication channel | Pass |

## Regression coverage

`build/test_release_set.py` protects:

- the exact main-push and configured-route dispatch gate;
- the source-owned route and credential names;
- route and credential validation;
- retry classification for transport errors, HTTP 429, and transient HTTP 5xx;
- immediate failure for non-retryable HTTP responses;
- the exact public dispatch payload schema.

## Disposition

The source route and conditional dispatch behavior are valid contracts. The
source contract now defines its two dispatch settings and delegates the complete
builder provisioning inventory to the builder-owned operational guide.
