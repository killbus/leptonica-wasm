/**
 * Raw C-ABI escape hatch (design §4.3).
 *
 * Loads the full-abi build (dist/full-abi/) and hands you the C ABI
 * with loose types. This module is documented danger: no semver, no
 * ownership, no validation. Prefer the curated layer unless you need
 * a leptonica function it does not expose.
 */

import { rawMemory, type RawMemory, type RawModule } from "./types.ts";

export {
  rawMemory,
  type Ptr,
  type RawFunction,
  type RawVoidFunction,
  type RawMemory,
  type RawModule,
  type RawSymbolHolder,
} from "./types.ts";

export interface RawLoadOptions {
  /**
   * The wasm bytes, e.g. read or fetched from dist/full-abi/leptonica.wasm.
   * Required: the heap views exposed on the result need the instance's
   * memory export, which is captured at instantiation time.
   */
  wasmBinary: ArrayBuffer | Uint8Array;
}

export interface RawInstance {
  /** The raw module — every C symbol as a loose function. */
  readonly raw: RawModule;
  /** Heap views tied to this module's memory. */
  readonly memory: RawMemory;
}

/** The Emscripten module factory emitted next to the wasm. */
type EmscriptenFactory = (moduleArg?: Record<string, unknown>) => Promise<RawModule>;

let factoryPromise: Promise<EmscriptenFactory> | null = null;

async function importFactory(): Promise<EmscriptenFactory> {
  // The full-abi artifacts live at dist/full-abi/ and are exposed as a
  // package subpath (see package.json "exports" "./raw"). Node resolves
  // this at runtime relative to the package root; bundlers follow the
  // subpath export.
  const mod = await import("leptonica-wasm/full-abi/leptonica.mjs");
  return mod.default as unknown as EmscriptenFactory;
}

/**
 * Instantiate the full-abi wasm build.
 *
 * The -O2 full-abi glue does not expose HEAP views on the module object,
 * so the memory export is captured at instantiation and exposed as heap
 * views on the result (see rawMemory). Views are re-derived per read to
 * survive heap growth (ALLOW_MEMORY_GROWTH).
 */
export async function loadRaw(options: RawLoadOptions): Promise<RawInstance> {
  if (options.wasmBinary == null || options.wasmBinary.byteLength === 0) {
    throw new Error(
      "loadRaw: wasmBinary is required — read or fetch the full-abi wasm" +
        " (subpath export \"leptonica-wasm/full-abi/leptonica.wasm\") and pass its bytes",
    );
  }
  factoryPromise ??= importFactory();
  const factory = await factoryPromise;
  let memory: WebAssembly.Memory | undefined;
  let instantiationFailed: (error: unknown) => void = () => {};
  const failure = new Promise<never>((_, reject) => {
    instantiationFailed = reject;
  });
  const module = factory({
    wasmBinary: options.wasmBinary,
    instantiateWasm(
      imports: WebAssembly.Imports,
      receiveInstance: (instance: WebAssembly.Instance) => void,
    ): void {
      WebAssembly.instantiate(options.wasmBinary as BufferSource, imports).then(
        (result) => {
          const mem = result.instance.exports.memory;
          if (mem instanceof WebAssembly.Memory) memory = mem;
          receiveInstance(result.instance);
        },
        (error) => {
          // Emscripten's instantiateWasm callback has no error channel: the
          // factory promise would hang forever (receiveInstance is never
          // called). Reject the race below with the real cause instead.
          instantiationFailed(error);
        },
      );
    },
  });
  // The factory promise hangs if instantiation fails (receiveInstance is
  // never called), so race it against the failure side-channel. A factory
  // rejection (import failure, compile failure outside instantiateWasm)
  // settles the race directly with the real error.
  const raw = await Promise.race([module, failure]);
  if (!memory) {
    throw new Error("full-abi module did not export its memory");
  }
  return { raw, memory: rawMemory(memory) };
}
