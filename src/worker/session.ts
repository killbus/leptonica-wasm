/**
 * Worker session client (design §5) — the recommended entry point.
 *
 * Pix handles live in the worker's arena; the main thread holds light
 * proxy objects carrying numeric handle ids. session.close() releases
 * every live Pix at once and poisons the session (decision ⑭: arena
 * model, no per-object remote dispose in v1). terminate() kills the
 * worker thread outright — the whole wasm heap dies with it.
 */

import type { HandleId, WorkerRequest, WorkerResponse } from "./protocol.ts";

/** Options for createSession. */
export interface SessionOptions {
  /**
   * Override for the wasm binary location. Default: the file sitting
   * next to the worker entry (dist/leptonica.wasm), resolved by the
   * worker itself — CDN/self-hosting users pass their own URL.
   */
  readonly wasmPath?: string | URL;
}

/** Main-thread proxy for a Pix living in the worker. */
export class RemotePix {
  /** @internal — session backref for request dispatch. */
  readonly #session: WorkerSession;
  /** @internal */
  readonly id: HandleId;
  /** @internal */
  readonly width: number;
  /** @internal */
  readonly height: number;
  /** @internal */
  readonly depth: number;
  #poisoned = false;

  /** @internal — constructed by WorkerSession only. */
  constructor(session: WorkerSession, id: HandleId, width: number, height: number, depth: number) {
    this.#session = session;
    this.id = id;
    this.width = width;
    this.height = height;
    this.depth = depth;
  }

  /** @internal — poisoning read (close() marks every proxy dead). */
  isPoisoned(): boolean {
    return this.#poisoned;
  }

  /** @internal — liveness gate for extract dispatch. */
  assertAlive(what: string): void {
    this.#assertAlive(what);
  }

  /** @internal — close() marks every proxy dead without a round trip. */
  poison(): void {
    this.#poisoned = true;
  }

  #assertAlive(what: string): void {
    if (this.#poisoned || this.#session.isClosed()) {
      throw new ReferenceError(`RemotePix is not usable (call: ${what})`);
    }
  }

  /** Encode to PNG bytes; the buffer transfers back to this thread. */
  toPNG(): Promise<Uint8Array> {
    // Liveness gates reject (not throw synchronously): these methods
    // return promises, and a poisoned proxy surfacing as a rejection is
    // the uniform failure shape across close()/terminate()/worker death.
    return this.#session.extract(this, "png");
  }

  /** Encode to JPEG bytes at quality 0-100. */
  toJPEG(quality: number): Promise<Uint8Array> {
    return this.#session.extract(this, "jpeg", quality);
  }

  /** Extract RGBA bytes (32bpp only). */
  toRGBA(): Promise<Uint8Array> {
    return this.#session.extract(this, "rgba");
  }

  /** Query: deskew angle estimate (1bpp only). */
  async findSkew(): Promise<{ angle: number; confidence: number }> {
    // Async method: liveness refusals surface as rejections, uniform
    // with toPNG/load/run (a poisoned proxy must never throw
    // synchronously out of a promise-returning method).
    await Promise.resolve().then(() => this.#assertAlive("findSkew"));
    return this.#session.query(this, { query: "findSkew" }).then((v) => {
      if (v.kind !== "findSkew") throw new TypeError("worker: findSkew response kind mismatch");
      return { angle: v.angle, confidence: v.confidence };
    });
  }

  /** Query: count of ON pixels (1bpp only). */
  async countPixels(): Promise<number> {
    await Promise.resolve().then(() => this.#assertAlive("countPixels"));
    return this.#session.query(this, { query: "countPixels" }).then((v) => {
      if (v.kind !== "countPixels") throw new TypeError("worker: countPixels response kind mismatch");
      return v.count;
    });
  }

  /** Query: connected components, 8-connectivity (1bpp only). */
  async connComp(): Promise<readonly { x: number; y: number; w: number; h: number }[]> {
    await Promise.resolve().then(() => this.#assertAlive("connComp"));
    return this.#session.query(this, { query: "connComp" }).then((v) => {
      if (v.kind !== "connComp") throw new TypeError("worker: connComp response kind mismatch");
      return v.boxes;
    });
  }

  /** Query: 256-bin gray histogram (8bpp). */
  async histogram(): Promise<readonly number[]> {
    await Promise.resolve().then(() => this.#assertAlive("histogram"));
    return this.#session.query(this, { query: "histogram" }).then((v) => {
      if (v.kind !== "histogram") throw new TypeError("worker: histogram response kind mismatch");
      return v.bins;
    });
  }

  /** Query: mean gray value. */
  async average(): Promise<number> {
    await Promise.resolve().then(() => this.#assertAlive("average"));
    return this.#session.query(this, { query: "average" }).then((v) => {
      if (v.kind !== "average") throw new TypeError("worker: average response kind mismatch");
      return v.value;
    });
  }
}

/** A live worker session. Obtain via createSession(). */
export class WorkerSession {
  /** @internal — postMessage-shaped transport (DOM Worker or worker_threads.Worker). */
  readonly #post: (msg: WorkerRequest, transfer?: Transferable[]) => void;
  /** @internal — live proxies, poisoned wholesale on close. */
  readonly #live = new Set<RemotePix>();
  /** @internal — pending request resolvers. */
  readonly #pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  /** @internal — adapter teardown, fired at most once. */
  readonly #teardown: (() => void) | undefined;
  #tornDown = false;
  #nextRequestId = 1;
  #closed = false;
  #terminated = false;

  /** @internal — created by createSession(). */
  constructor(
    post: (msg: WorkerRequest, transfer?: Transferable[]) => void,
    onMessage: (cb: (r: WorkerResponse) => void) => void,
    /** @internal — adapter hook: kill the platform worker once the session is dead. */
    teardown?: () => void,
  ) {
    this.#post = post;
    this.#teardown = teardown;
    onMessage((response) => this.#onResponse(response));
  }

  /** @internal */
  isClosed(): boolean {
    return this.#closed || this.#terminated;
  }

  /** @internal — run the adapter teardown exactly once. */
  #runTeardown(): void {
    if (this.#tornDown) return;
    this.#tornDown = true;
    this.#teardown?.();
  }

  /**
   * @internal — handshake: let the worker load the wasm module (with an
   * optional wasmPath override) before the first user request. The
   * adapters call this right after wiring message handlers.
   */
  init(wasmPath?: string | URL): Promise<void> {
    return this.#request({ id: this.#nextRequestId++, type: "init", ...(wasmPath !== undefined ? { wasmPath: String(wasmPath) } : {}) }).then((r) => {
      if (!r.ok || r.type !== "init") throw new Error(`init: unexpected response ${JSON.stringify(r)}`);
    });
  }

  /**
   * Load RGBA bytes as a new 32bpp Pix in the worker's arena.
   * The buffer is transferred, not copied — the caller's view detaches.
   */
  load(data: Uint8Array | ArrayBufferView, w: number, h: number): Promise<RemotePix> {
    // Async API: refusals surface as rejections, uniform with the
    // poisoned-proxy path (see toPNG).
    try {
      this.#assertOpen("load");
    } catch (err) {
      return Promise.reject(err);
    }
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      throw new RangeError(`load: bad dimensions ${w}x${h}`);
    }
    const bytes = data.buffer instanceof ArrayBuffer ? data.buffer : data;
    if (bytes.byteLength !== w * h * 4) {
      throw new RangeError(`load: expected ${w * h * 4} bytes, got ${bytes.byteLength}`);
    }
    return this.#request({ id: this.#nextRequestId++, type: "load", buffer: bytes as ArrayBuffer, w, h }, [bytes as ArrayBuffer]).then((r) => {
      if (!r.ok || r.type !== "load") throw new Error(`load: unexpected response ${JSON.stringify(r)}`);
      const pix = new RemotePix(this, r.handle, r.width, r.height, r.depth);
      this.#live.add(pix);
      return pix;
    });
  }

  /**
   * Chain ops on a source Pix. The whole op array goes over as ONE
   * message (design §5.1: builder IS the protocol — run() is the only
   * round trip, one await).
   */
  async run(source: RemotePix, ops: readonly import("../protocol.ts").Op[]): Promise<RemotePix> {
    try {
      this.#assertOpen("run");
      this.#assertOwns(source, "run");
    } catch (err) {
      return Promise.reject(err);
    }
    if (source.isPoisoned()) throw new ReferenceError("run: source RemotePix is not usable");
    const r = await this.#request({ id: this.#nextRequestId++, type: "run", source: source.id, ops: [...ops] });
    if (!r.ok || r.type !== "run") throw new Error(`run: unexpected response ${JSON.stringify(r)}`);
    const pix = new RemotePix(this, r.handle, r.width, r.height, r.depth);
    this.#live.add(pix);
    return pix;
  }

  /** Every live Pix in the worker's arena is released; the session is poisoned. */
  async close(): Promise<void> {
    // A terminated session is already fully torn down (markTerminated
    // released the worker and poisoned every proxy); close() after
    // worker death must stay a no-op resolve, not throw — callers
    // routinely reach for close() in cleanup/finally paths after
    // observing the death. Without this guard the farewell request
    // hits #request's isClosed() gate and rejects.
    if (this.isClosed()) return;
    // Send the close request BEFORE flipping the flag — #request() gates
    // on isClosed() and would reject our own farewell message.
    const farewell = this.#request({ id: this.#nextRequestId++, type: "close" });
    for (const pix of this.#live) pix.poison();
    this.#live.clear();
    try {
      this.#closed = true;
      // close is an instruction, not a request that needs the worker's
      // confirmation: if the worker dies mid-handshake (exit event
      // arriving while the farewell is in flight), the pending farewell
      // is rejected by markTerminated — swallowing it keeps close()
      // usable in finally/cleanup paths without masking the original
      // error the caller is already handling.
      await farewell.catch(() => {});
    } finally {
      this.#rejectPending(new Error("session closed"));
      this.#runTeardown();
    }
  }

  /**
   * Kill the worker thread outright — the whole wasm heap dies with it
   * (design §5: the nuclear option). In-flight requests reject with
   * "worker terminated"; every live proxy is poisoned; close() after
   * this is a no-op resolve. Use when close() cannot drain fast enough
   * (a long-running op holds the farewell FIFO slot indefinitely).
   */
  terminate(): void {
    this.markTerminated();
  }

  /** @internal — mark terminated without a round trip (worker died). */
  markTerminated(): void {
    this.#terminated = true;
    for (const pix of this.#live) pix.poison();
    this.#live.clear();
    this.#rejectPending(new Error("worker terminated"));
    this.#runTeardown();
  }

  /** @internal — extract dispatch (RemotePix calls this; it checks liveness itself). */
  extract(pix: RemotePix, format: "rgba" | "png" | "jpeg", quality?: number): Promise<Uint8Array> {
    const req: WorkerRequest = { id: this.#nextRequestId++, type: "extract", handle: pix.id, format, ...(quality !== undefined ? { quality } : {}) };
    return this.#request(req).then((r) => {
      if (!r.ok || r.type !== "extract") throw new Error(`extract: unexpected response ${JSON.stringify(r)}`);
      return new Uint8Array(r.buffer);
    });
  }

  /** @internal — query dispatch (RemotePix checks liveness itself). */
  query(pix: RemotePix, query: import("../protocol.ts").Query): Promise<Extract<WorkerResponse, { ok: true; type: "query" }>["value"]> {
    return this.#request({ id: this.#nextRequestId++, type: "query", handle: pix.id, query }).then((r) => {
      if (!r.ok || r.type !== "query") throw new Error(`query: unexpected response ${JSON.stringify(r)}`);
      return r.value;
    });
  }

  #request(msg: WorkerRequest, transfer?: Transferable[]): Promise<WorkerResponse> {
    if (this.isClosed()) {
      return Promise.reject(new ReferenceError("WorkerSession is closed"));
    }
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.#pending.set(msg.id, { resolve, reject });
      this.#post(msg, transfer);
    });
  }

  #onResponse(response: WorkerResponse): void {
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      // A response for a request we already rejected (e.g. after close).
      return;
    }
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response);
    } else {
      pending.reject(new Error(response.error));
    }
  }

  #rejectPending(err: Error): void {
    for (const { reject } of this.#pending.values()) reject(err);
    this.#pending.clear();
  }

  #assertOwns(pix: RemotePix, what: string): void {
    if (!this.#live.has(pix)) {
      throw new TypeError(`${what}: RemotePix belongs to a different session`);
    }
  }

  #assertOpen(what: string): void {
    if (this.isClosed()) {
      throw new ReferenceError(`WorkerSession is closed (call: ${what})`);
    }
  }
}
