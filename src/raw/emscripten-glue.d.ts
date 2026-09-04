/**
 * Ambient declaration for the Emscripten module factory emitted by the
 * full-abi build (dist/full-abi/leptonica.mjs). The artifact is build
 * output (not in git); this declaration pins its consumer-facing shape.
 */
declare module "leptonica-wasm/full-abi/leptonica.mjs" {
  interface EmscriptenModuleArg {
    wasmBinary?: ArrayBuffer | Uint8Array;
    instantiateWasm?(
      imports: WebAssembly.Imports,
      receiveInstance: (instance: WebAssembly.Instance) => void,
    ): unknown;
    [key: string]: unknown;
  }
  const factory: (moduleArg?: EmscriptenModuleArg) => Promise<Record<string, unknown>>;
  export default factory;
}
