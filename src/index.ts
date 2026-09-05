/**
 * Package entry point — the curated layer.
 *
 * - Synchronous core: Leptonica.load() → fromRGBA/chain/queries/extract.
 * - Worker session client: import from "leptonica-wasm/worker" (M5).
 * - Raw C-ABI escape hatch: import from "leptonica-wasm/raw".
 */
export { load } from "./core/load.ts";
export { Leptonica, Pix } from "./core/types.ts";
export type { Box, SkewResult } from "./core/types.ts";
export type { ChainBuilder } from "./core/chain.ts";
