/**
 * The worker entry (design §5.3) — runs INSIDE the worker thread.
 *
 * One Leptonica instance per worker (decision ⑧: Leptonica has global
 * state; one-instance-per-worker is the safety model). The wasm binary
 * is located next to this file by default (new URL + import.meta.url);
 * the session client can override the location via wasmPath, forwarded
 * through the init handshake.
 *
 * The arena (decision ⑭): every Pix created here stays here; close()
 * destroys all of them at once. Intermediates from a failed run() die
 * inside the request handler (design §5.2) — the error path is also a
 * call-stack-local death.
 */

import type { CuratedModule } from "../core/emscripten-glue-shape.d.ts";
import { shouldRetireWasmInstance, Leptonica } from "../core/types.ts";
// Statically imported (not dynamically): bundlers must see the wasm
// loader as a hard dependency of the worker entry so it lands in the
// worker chunk. A dynamic import is left as a runtime path by several
// bundlers (observed: vite/rolldown), which 404s in the browser.
import leptonicaFactory from "leptonica-wasm/leptonica.mjs";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { wireWorker } from "./arena.ts";
import type { PostSurface } from "./arena.ts";

// Boot: the worker starts idle. The session client's init handshake
// carries an optional wasmPath override; boot happens then, and the
// reply confirms the module is live before any load/run request.
async function main(): Promise<void> {
  const surface = await detectSurface();
  let fatalError: string | null = null;
  surface.onMessage(async (req) => {
    if (fatalError !== null) {
      surface.post({ id: req.id, ok: false, fatal: true, error: fatalError });
      return;
    }
    const replyErr = (error: string) => surface.post({ id: (req as { id: number }).id, ok: false, error });
    if (req.type !== "init") {
      // Before init, everything else is a protocol error.
      replyErr("worker: not initialized (init required first)");
      return;
    }
    // The init gate is single-shot: a second init would double-boot
    // the wasm heap. Reply with a protocol error, never silence.
    if (booted) {
      replyErr("worker: already initialized (init is single-shot)");
      return;
    }
    booted = true;
    try {
      const moduleArg: import("../core/emscripten-glue-shape.d.ts").EmscriptenModuleArg = {};
      if (req.wasmPath !== undefined) {
        moduleArg.locateFile = () => req.wasmPath as string;
      }
      const module: CuratedModule = await leptonicaFactory(moduleArg);
      const lp = new Leptonica(module);
      wireWorker(lp, surface);
      surface.post({ id: req.id, ok: true, type: "init" });
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      if (shouldRetireWasmInstance(err)) {
        fatalError = message;
        surface.post({ id: req.id, ok: false, fatal: true, error: message });
      } else {
        surface.post({ id: req.id, ok: false, error: message });
      }
    }
  });
}

let booted = false;

/** Pick the postMessage surface by environment. */
async function detectSurface(): Promise<PostSurface> {
  // Node worker_threads sets the process global and has no
  // WorkerGlobalScope; DOM workers are the inverse.
  const isNode =
    typeof (globalThis as { process?: unknown }).process === "object" &&
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope === "undefined";
  return isNode ? nodeSurface() : Promise.resolve(domSurface());
}

/** DOM Worker globals: self.onmessage / self.postMessage. */
function domSurface(): PostSurface {
  const ctx = self as unknown as {
    onmessage: ((ev: { data: WorkerRequest }) => void) | null;
    postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  };
  return {
    post: (msg, transfer) => ctx.postMessage(msg, transfer),
    onMessage: (cb) => {
      ctx.onmessage = (ev) => cb(ev.data);
    },
  };
}

/** Node worker_threads: parentPort surface (dynamic, string-keyed import). */
async function nodeSurface(): Promise<PostSurface> {
  // String specifier keeps the web domain's compiler from resolving the
  // Node-only module; the shape is declared inline. Only ArrayBuffers
  // ever cross the wire in this protocol, so the transfer mapping is
  // pass-through.
  const mod = (await import("node:worker_threads" as string)) as {
    parentPort: {
      on(event: "message", cb: (m: WorkerRequest) => void): void;
      removeAllListeners(event: "message"): void;
      postMessage(msg: WorkerResponse, transfer?: readonly ArrayBuffer[]): void;
    } | null;
  };
  const parentPort = mod.parentPort;
  if (parentPort === null) throw new Error("worker entry: no parentPort in Node mode");
  return {
    post: (msg, transfer) => parentPort.postMessage(msg, (transfer ?? []) as readonly ArrayBuffer[]),
    onMessage: (cb) => {
      // DOM onmessage is a single-slot assignment; Node's EventEmitter
      // accumulates listeners. The init gate registers first and
      // wireWorker replaces it after boot — so registering here must
      // first clear any previous listener (parity with the DOM side).
      parentPort.removeAllListeners("message");
      parentPort.on("message", cb as (m: WorkerRequest) => void);
    },
  };
}

void main();
