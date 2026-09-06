# Golden chain fixtures (M4)

Each entry in chains.json is one op chain + query list the oracle harness
(cpp/oracle.c) and the wasm side must agree on:

- PNG output: byte-identical (same zlib/libpng pins, deterministic encoders)
- Scalar JSON (skewAngle/skewConf/pixelCount): tolerance-based compare

The rgba input is generated deterministically from (width, height) by
generate-rgba.mjs — the same bytes on both sides, no binary fixture in git.

CI wiring: the native-oracle job runs run-oracle.mjs (produces goldens/
and uploads them), the ci job downloads the goldens before its Test step
and runs the vitest golden suite which replays the same chains through the
wasm bindings and compares. goldens/ is gitignored — no binary fixture in
the repo, every CI run regenerates them from the pinned oracle.
