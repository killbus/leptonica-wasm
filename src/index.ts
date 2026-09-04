/**
 * Package entry point.
 *
 * The curated layer (M4) will be the documented main API. Until it lands,
 * only the raw escape hatch exists — import from "leptonica-wasm/raw".
 * The full-abi wasm itself is the "leptonica-wasm/full-abi/leptonica.wasm"
 * subpath export.
 */
export const curatedLayerPending = true as const;
