import { Leptonica } from "./types.ts";

/**
 * Instantiate the curated wasm module (default build, dist/leptonica.mjs).
 *
 * Each call creates a fresh module with its own heap. Handles are
 * instance-scoped — never mix Pix objects across instances.
 */
export async function load(): Promise<Leptonica> {
  const factory = (await import("leptonica-wasm/leptonica.mjs")).default;
  const module = await factory();
  return new Leptonica(module);
}
