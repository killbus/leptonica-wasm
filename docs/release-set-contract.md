# Source-Owned Release-Set Contract

## Boundary

`variants/*.json` is the private source of truth for release membership, domain
mapping, and compile-time lock behavior. Every valid JSON file committed
directly under `variants/` participates in the release set. Membership and
configuration are read from the exact Git tree named by `source_revision`;
untracked files and dirty working-tree edits cannot alter that revision's
manifest.

The builder-facing contract exposes only opaque target identities and
operational build roles. It never exposes variant names, domains, descriptions,
`PRODUCT_LOCK`, `BUILD_VARIANT`, target seeds, or the source repository
owner/name. The builder obtains the allowed source repository only through its
private secret control plane.

## Private variant schema

Each variant contains exactly these fields:

- `variant`: private selector matching `p0` or `pN` without leading zeroes;
- `domain`: normalized lowercase hostname for a locked target, otherwise `null`;
- `product_lock`: integer `0` or `1`;
- `description`: non-empty private description;
- `target_seed`: unique immutable 32-byte value encoded as lowercase hex.

The unlocked development target is exactly `p0`. Locked targets fail closed in
browsers unless `location.hostname` is the configured hostname or one of its
subdomains. Node.js and Node `worker_threads` are trusted build/test contexts.

## Public manifest schema v1

```json
{
  "schema_version": 1,
  "release_id": "release-v1-<64 lowercase hex characters>",
  "source_revision": "<40-character lowercase Git SHA>",
  "targets": [
    {
      "target_id": "target-v1-<64 lowercase hex characters>",
      "build_role": "dev",
      "outputs": ["leptonica.wasm", "leptonica.mjs", "build-info.json"],
      "transport_profile": "envelope-v1"
    }
  ]
}
```

`build_role` is `dev` or `prod`; it is an operational role, not a visibility
decision. Publication policy remains builder-owned. Both roles use the same
`envelope-v1` candidate transport.

## Canonical identities

Schema v1 uses ASCII-compatible canonical JSON: object keys are sorted, no
insignificant whitespace is emitted, array order is preserved, and targets are
sorted by `target_id`. Identity hashing uses the independent domains
`leptonica-release-target-v1` and `leptonica-release-set-v1`. A source revision,
membership, role, output contract, transport profile, or seed change therefore
produces a different immutable release identity.

## Source commands

```bash
python3 build/release_set.py manifest \
  --source-revision "$SOURCE_REVISION" \
  --output release-set.json

python3 build/release_set.py verify \
  --source-revision "$SOURCE_REVISION" \
  --manifest release-set.json \
  --release-id "$RELEASE_ID" \
  --target-id "$TARGET_ID"

python3 build/release_set.py build \
  --source-revision "$SOURCE_REVISION" \
  --release-id "$RELEASE_ID" \
  --target-id "$TARGET_ID"
```

The opaque `build` command resolves the private variant internally and invokes
`node scripts/build.mjs --variant <private selector>`. Callers must not supply
`BUILD_VARIANT`, `PRODUCT_LOCK`, or `BUILD_TYPE`. Its `dist/build-info.json`
contains only `schema_version`, `release_id`, `source_revision`, `target_id`,
`build_role`, and `transport_profile`.

## Dispatch configuration

After the source CI build and reproducibility comparison pass on `main`, the
workflow sends `source-release-set-v1` to the builder. Configure the source
repository with:

- repository variable `LEPTONICA_BUILDER_REPOSITORY`: `owner/repository` of the
  builder;
- repository secret `LEPTONICA_BUILDER_DISPATCH_TOKEN`: a fine-grained token
  able to dispatch workflows in that repository.

Operators configure these explicit source-owned contracts. A configured
repository route activates builder dispatch, and the dispatch job validates the
route and credential before sending the event.

The builder repository owns its configuration. Its
`docs/candidate-transport.md` is the canonical inventory and provisioning guide,
and this source contract delegates builder setup to that guide.

The dispatch payload contains only contract version 1, the exact source
revision, immutable release ID, and canonical public manifest. Transport errors,
HTTP 429, and transient 5xx responses are retried with bounded exponential
backoff until the workflow timeout; non-retryable responses fail immediately.

## Versioning

Schema fields, domain-separation strings, prefixes, canonicalization, target
ordering, required outputs, and the transport profile are identity-bearing. Any
incompatible interpretation requires a new schema and identity version.
