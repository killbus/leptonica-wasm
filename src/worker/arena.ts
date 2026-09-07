import { runChain } from "../core/chain.ts";
import { shouldRetireWasmInstance, Leptonica, type Pix } from "../core/types.ts";
import type { Op, Query } from "../protocol.ts";
import { toTransferableArrayBuffer } from "./bytes.ts";
import type { HandleId, WorkerRequest, WorkerResponse } from "./protocol.ts";

/**
 * The postMessage surface shared by browser and Node worker adapters.
 * Keeping it here makes the arena/protocol boundary testable without
 * importing the production worker entry or its generated WASM loader.
 */
export interface PostSurface {
  post(msg: WorkerResponse, transfer?: Transferable[]): void;
  onMessage(cb: (req: WorkerRequest) => void): void;
}

/** The worker-side arena: every adopted Pix belongs to one Leptonica heap. */
export class WorkerArena {
  readonly #lp: Leptonica;
  readonly #pixes = new Map<HandleId, Pix>();
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

  extract(handle: HandleId, format: "rgba" | "png" | "jpeg" | "mask", quality?: number): ArrayBuffer {
    const pix = this.#get(handle, "extract");
    const bytes = format === "png"
      ? pix.toPNG()
      : format === "jpeg"
      ? pix.toJPEG(quality ?? 85)
      : format === "mask"
      ? pix.toMask().data
      : pix.toRGBA();
    // Curated extraction returns an ordinary, JS-owned full Uint8Array, so
    // this is normally a zero-copy handoff. The helper keeps a safe exact-copy
    // fallback if a future implementation returns a partial or shared view.
    return toTransferableArrayBuffer(bytes);
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

  #adopt(pix: Pix): { handle: HandleId; width: number; height: number; depth: number } {
    let width: number;
    let height: number;
    let depth: number;
    try {
      // Metadata access is native and can fail. Do not publish or retain an
      // arena handle until all response metadata has been read successfully.
      width = pix.width;
      height = pix.height;
      depth = pix.depth;
    } catch (error) {
      // A fatal trap has already poisoned the Pix, making dispose() a no-op;
      // an ordinary metadata failure still owns a live native handle and must
      // release it before the request returns an error.
      pix.dispose();
      throw error;
    }
    const handle = this.#nextHandleId++;
    this.#pixes.set(handle, pix);
    return { handle, width, height, depth };
  }

  #get(handle: HandleId, what: string): Pix {
    const pix = this.#pixes.get(handle);
    if (pix === undefined) throw new ReferenceError(`${what}: handle ${handle} not found`);
    return pix;
  }
}

/** Wire the arena to a postMessage surface. */
export function wireWorker(lp: Leptonica, surface: PostSurface): void {
  const arena = new WorkerArena(lp);
  let fatalError: string | null = null;
  surface.onMessage((req) => {
    const reply = (res: WorkerResponse, transfer?: Transferable[]) => surface.post(res, transfer);
    // A trap invalidates the whole WASM instance. Keep the platform worker
    // alive just long enough for the client to observe the terminal control
    // message and take teardown ownership; never re-enter the retired heap.
    // Repeating the fatal response also closes requests already queued before
    // the first fatal message reached the client.
    if (fatalError !== null) {
      reply({ id: req.id, ok: false, fatal: true, error: fatalError });
      return;
    }
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
          // (a silent no-reply leaves the caller's pending forever).
          reply({ id: req.id, ok: false, error: `worker: unknown request type ${String((req as { type: string }).type)}` });
          return;
      }
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      if (shouldRetireWasmInstance(err)) {
        // postMessage queues the terminal signal for the owner. Closing the
        // Worker here can make that last signal unobservable to the browser
        // client, which has no DOM Worker exit event. The client terminates
        // the platform Worker after markTerminated() rejects every pending
        // request; until then this terminal gate prevents further WASM entry.
        fatalError = message;
        reply({ id: req.id, ok: false, fatal: true, error: message });
        return;
      }
      reply({ id: req.id, ok: false, error: message });
    }
  });
}
