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
import { Leptonica } from "../core/types.ts";
import { runChain } from "../core/chain.ts";
// Statically imported (not dynamically): bundlers must see the wasm
// loader as a hard dependency of the worker entry so it lands in the
// worker chunk. A dynamic import is left as a runtime path by several
// bundlers (observed: vite/rolldown), which 404s in the browser.
import leptonicaFactory from "leptonica-wasm/leptonica.mjs";
import type { Op, Query } from "../protocol.ts";
import type { HandleId, WorkerRequest, WorkerResponse } from "./protocol.ts";

/**
 * The postMessage surface, abstracted over DOM Worker globals and Node
 * worker_threads (parentPort). Both provide the same two operations the
 * entry needs: send a response, optionally with transfer list.
 */
interface PostSurface {
  post(msg: WorkerResponse, transfer?: Transferable[]): void;
  onMessage(cb: (req: WorkerRequest) => void): void;
}

/** The worker-side arena. */
class WorkerArena {
  readonly #lp: Leptonica;
  readonly #pixes = new Map<HandleId, InstanceType<typeof import("../core/types.ts").Pix>>();
  #nextHandleId = 1;
  #closed = false;

  constructor(lp: Leptonica) {
    this.#lp = lp;
  }

  load(buffer: ArrayBuffer, w: number, h: number): { handle: HandleId; width: number; height: number; depth: number } {
    const pix = this.#lp.fromRGBA(new Uint8Array(buffer), w, h);
    return this.#adopt(pix);
  }

  run(source: HandleId, ops: readonly Op[]): { handle: HandleId; width: number; height: number; depth: number } {
    const src = this.#pixes.get(source);
    if (src === undefined) throw new ReferenceError(`run: handle ${source} not found`);
    // runChain destroys intermediates on both success and failure paths
    // (design §5.2) — nothing survives the request handler.
    const result = runChain(this.#lp, src, ops);
    return this.#adopt(result);
  }

  extract(handle: HandleId, format: "rgba" | "png" | "jpeg", quality?: number): ArrayBuffer {
    const pix = this.#get(handle, "extract");
    const bytes = format === "png" ? pix.toPNG() : format === "jpeg" ? pix.toJPEG(quality ?? 85) : pix.toRGBA();
    // Transfer, not clone (design §5.2): the wasm-heap-aliased view was
    // already copied by the Pix method; hand the buffer over the wire.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }

  query(handle: HandleId, query: Query): WorkerResponse {
    const pix = this.#get(handle, "query");
    switch (query.query) {
      case "findSkew": {
        const r = pix.findSkew();
        return { id: 0, ok: true, type: "query", value: { kind: "findSkew", angle: r.angle, confidence: r.confidence } };
      }
      case "connComp":
        return { id: 0, ok: true, type: "query", value: { kind: "connComp", boxes: pix.connComp() } };
      case "countPixels":
        return { id: 0, ok: true, type: "query", value: { kind: "countPixels", count: pix.countPixels() } };
      case "histogram":
        return { id: 0, ok: true, type: "query", value: { kind: "histogram", bins: [...pix.histogram()] } };
      case "average":
        return { id: 0, ok: true, type: "query", value: { kind: "average", value: pix.average() } };
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // Leptonica.close() destroys every live Pix and poisons the arena.
    this.#lp.close();
    this.#pixes.clear();
  }

  #adopt(pix: InstanceType<typeof import("../core/types.ts").Pix>): { handle: HandleId; width: number; height: number; depth: number } {
    const handle = this.#nextHandleId++;
    this.#pixes.set(handle, pix);
    return { handle, width: pix.width, height: pix.height, depth: pix.depth };
  }

  #get(handle: HandleId, what: string): InstanceType<typeof import("../core/types.ts").Pix> {
    const pix = this.#pixes.get(handle);
    if (pix === undefined) throw new ReferenceError(`${what}: handle ${handle} not found`);
    return pix;
  }
}

/** Wire the arena to a postMessage surface. Exported for tests. */
export function wireWorker(lp: Leptonica, surface: PostSurface): void {
  const arena = new WorkerArena(lp);
  surface.onMessage((req) => {
    const reply = (res: WorkerResponse, transfer?: Transferable[]) => surface.post(res, transfer);
    try {
      switch (req.type) {
        case "load": {
          const r = arena.load(req.buffer, req.w, req.h);
          reply({ id: req.id, ok: true, type: "load", ...r }, [req.buffer]);
          return;
        }
        case "run": {
          const r = arena.run(req.source, req.ops);
          reply({ id: req.id, ok: true, type: "run", ...r });
          return;
        }
        case "extract": {
          const buffer = arena.extract(req.handle, req.format, req.quality);
          reply({ id: req.id, ok: true, type: "extract", buffer }, [buffer]);
          return;
        }
        case "query": {
          const res = arena.query(req.handle, req.query);
          reply({ ...res, id: req.id });
          return;
        }
        case "close":
          arena.close();
          reply({ id: req.id, ok: true, type: "close" });
          return;
        default:
          // Unknown message types must not evaporate from the mailbox
          // (a silent no-reply leaves the caller's pending forever):
          // answer loudly with a protocol error instead.
          reply({ id: req.id, ok: false, error: `worker: unknown request type ${String((req as { type: string }).type)}` });
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      reply({ id: req.id, ok: false, error: message });
    }
  });
}

// Boot: the worker starts idle. The session client's init handshake
// carries an optional wasmPath override; boot happens then, and the
// reply confirms the module is live before any load/run request.
async function main(): Promise<void> {
  const surface = await detectSurface();
  surface.onMessage(async (req) => {
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
      surface.post({ id: req.id, ok: false, error: message });
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
