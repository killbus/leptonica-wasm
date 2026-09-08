# Boundary review - version 2

Date: 2026-09-06.

## Trigger

During implementation, the user identified that Leptonica and leptonica-wasm
are not intended to serve only pdfhow's document-cleaning scenario. This
exposed a responsibility error in planning version 1: it promoted one
consumer's recipe and defaults into the general binding contract.

## Corrected decision

- Leptonica owns native algorithms and the full ABI.
- leptonica-wasm owns safe, typed, resource-managed curated primitives and
  transport parity.
- pdfhow or another consumer owns pipeline order, defaults, output policy,
  color composition, deskew thresholds, and fallback behavior.
- The unfinished documentClean API, worker request, cancellation state machine,
  and document-specific native helpers are removed.
- Background normalization, tiled Sauvola, explicit area/connectivity
  selection, color-pixel masks, and packed-mask extraction remain because they
  are direct reusable Leptonica capabilities.
- New policy-bearing primitive arguments are explicit; pdfhow's values may be
  used by an external benchmark profile but are not package defaults.

## Consequences

Planning review version 1 remains as historical evidence of the approved
proposal, but its documentClean-specific decisions are superseded. The current
PRD, design, and implementation plan are authoritative.

This correction narrows the library API while preserving the original
ownership, package, worker parity, resource, benchmark, and ordinary-PR gates.
It does not claim that unwrapped Leptonica capabilities are unavailable: the
raw/full ABI remains the advanced escape hatch with caller-managed ownership.
