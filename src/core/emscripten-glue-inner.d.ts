/**
 * Inner (non-ambient) form of emscripten-glue.d.ts — module shape only.
 * gen-types.mjs resolves the package-internal "leptonica-wasm/leptonica.mjs"
 * specifier through this file during declaration emit (tsc's paths mapping
 * cannot point at an ambient declare-module file and also resolve named
 * type exports from it).
 */
export type { EmscriptenModuleArg, PixHandle, CuratedModule } from "./emscripten-glue-shape.d.ts";
import type { EmscriptenModuleArg, CuratedModule } from "./emscripten-glue-shape.d.ts";
declare const factory: (moduleArg?: EmscriptenModuleArg) => Promise<CuratedModule>;
export default factory;
