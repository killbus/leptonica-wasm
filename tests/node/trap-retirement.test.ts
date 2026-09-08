import { describe, expect, it } from "vitest";
import type { CuratedModule, PixHandle } from "../../src/core/emscripten-glue-shape.d.ts";
import { shouldRetireWasmInstance, Leptonica } from "../../src/core/types.ts";
import { createSession as createBrowserSession } from "../../src/worker/index.ts";
import { WorkerSession } from "../../src/worker/session.ts";
import type { WorkerRequest, WorkerResponse } from "../../src/worker/protocol.ts";
import { wireWorker } from "../../src/worker/arena.ts";

function fakeHandle(): PixHandle {
  return {
    delete: () => undefined,
    deleteLater() { return this; },
    isDeleted: () => false,
  };
}

function fakeModule(overrides: Partial<CuratedModule> = {}): CuratedModule {
  const handle = fakeHandle();
  return {
    fromRGBA: () => handle,
    destroyPix: () => undefined,
    pixWidth: () => 1,
    pixHeight: () => 1,
    pixDepth: () => 32,
    toPNG: () => new Uint8Array([0x89, 0x50]),
    ...overrides,
  } as CuratedModule;
}

describe("fatal WebAssembly trap retirement", () => {
  it("tears down the production browser worker once when init reports fatal", async () => {
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    let instance: FakeInitFatalWorker | undefined;

    class FakeInitFatalWorker {
      readonly listeners = new Map<string, Array<(event: { data: WorkerResponse }) => void>>();
      terminateCalls = 0;

      constructor() {
        instance = this;
      }

      addEventListener(type: string, callback: (event: { data: WorkerResponse }) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(callback);
        this.listeners.set(type, listeners);
      }

      postMessage(request: WorkerRequest): void {
        if (request.type !== "init") return;
        queueMicrotask(() => {
          for (const listener of this.listeners.get("message") ?? []) {
            listener({
              data: {
                id: request.id,
                ok: false,
                fatal: true,
                error: "RuntimeError: unreachable during init",
              },
            });
          }
        });
      }

      terminate(): void {
        this.terminateCalls++;
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: FakeInitFatalWorker,
    });
    try {
      await expect(createBrowserSession()).rejects.toThrow(/fatal WebAssembly trap/);
      expect(instance?.terminateCalls).toBe(1);
    } finally {
      if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else Object.defineProperty(globalThis, "Worker", originalWorker);
    }
  });

  it("routes a fatal response through the production browser adapter teardown", async () => {
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    let instance: FakeBrowserWorker | undefined;

    class FakeBrowserWorker {
      readonly listeners = new Map<string, Array<(event: { data: WorkerResponse }) => void>>();
      terminateCalls = 0;
      #fatalScheduled = false;

      constructor() {
        instance = this;
      }

      addEventListener(type: string, callback: (event: { data: WorkerResponse }) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(callback);
        this.listeners.set(type, listeners);
      }

      postMessage(request: WorkerRequest): void {
        if (request.type === "init") {
          queueMicrotask(() => this.#emit({ id: request.id, ok: true, type: "init" }));
          return;
        }
        if (request.type === "load" && !this.#fatalScheduled) {
          this.#fatalScheduled = true;
          queueMicrotask(() => this.#emit({
            id: request.id,
            ok: false,
            fatal: true,
            error: "RuntimeError: unreachable",
          }));
        }
      }

      terminate(): void {
        this.terminateCalls++;
      }

      #emit(response: WorkerResponse): void {
        for (const listener of this.listeners.get("message") ?? []) {
          listener({ data: response });
        }
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      writable: true,
      value: FakeBrowserWorker,
    });
    try {
      const session = await createBrowserSession();
      const first = session.load(new Uint8Array(4), 1, 1);
      const second = session.load(new Uint8Array(4), 1, 1);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.allSettled([first, second]).finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("browser adapter pending requests did not settle")), 250);
        }),
      ]);

      expect(settled.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(instance?.terminateCalls).toBe(1);
      await expect(session.load(new Uint8Array(4), 1, 1)).rejects.toThrow(
        /WorkerSession is terminated/,
      );
      await expect(session.close()).resolves.toBeUndefined();
      expect(instance?.terminateCalls).toBe(1);
    } finally {
      if (originalWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
      else Object.defineProperty(globalThis, "Worker", originalWorker);
    }
  });

  it("poisons a direct instance without invoking native destructors after a trap", () => {
    let destroyCalls = 0;
    const module = fakeModule({
      destroyPix: () => { destroyCalls++; },
      toPNG: () => { throw new WebAssembly.RuntimeError("unreachable"); },
    });
    const lp = new Leptonica(module);
    const pix = lp.fromRGBA(new Uint8Array(4), 1, 1);

    expect(() => pix.toPNG()).toThrow(WebAssembly.RuntimeError);
    expect(() => pix.width).toThrow(ReferenceError);
    expect(() => lp.fromRGBA(new Uint8Array(4), 1, 1)).toThrow(/retired/);
    expect(() => lp.close()).not.toThrow();
    expect(destroyCalls).toBe(0);
  });

  it("retires conservatively for cross-realm RuntimeError shapes", async () => {
    const { runInNewContext } = await import("node:vm");
    const crossRealmTrap = runInNewContext('new WebAssembly.RuntimeError("unreachable")');
    const runtimeErrorLike = runInNewContext(`
      new (class RuntimeError extends Error {
        constructor() {
          super("not distinguishable portably from a cross-realm trap");
          this.name = "RuntimeError";
        }
      })()
    `);
    const renamed = new Error("not a trap");
    renamed.name = "RuntimeError";

    expect(shouldRetireWasmInstance(crossRealmTrap)).toBe(true);
    expect(shouldRetireWasmInstance(runtimeErrorLike)).toBe(true);
    expect(shouldRetireWasmInstance(renamed)).toBe(false);
  });

  it("does not retire the instance for an ordinary operation error", () => {
    let fail = true;
    let destroyCalls = 0;
    const module = fakeModule({
      destroyPix: () => { destroyCalls++; },
      toPNG: () => {
        if (fail) throw new Error("recoverable encoder failure");
        return new Uint8Array([0x89, 0x50]);
      },
    });
    const lp = new Leptonica(module);
    const pix = lp.fromRGBA(new Uint8Array(4), 1, 1);

    expect(() => pix.toPNG()).toThrow(/recoverable encoder failure/);
    fail = false;
    expect(pix.toPNG()).toEqual(new Uint8Array([0x89, 0x50]));
    pix.dispose();
    expect(destroyCalls).toBe(1);
  });

  it("releases a Pix when response metadata fails before handle publication", () => {
    let failWidth = true;
    let destroyCalls = 0;
    const lp = new Leptonica(fakeModule({
      fromRGBA: () => fakeHandle(),
      pixWidth: () => {
        if (failWidth) {
          failWidth = false;
          throw new Error("recoverable metadata failure");
        }
        return 1;
      },
      destroyPix: () => { destroyCalls++; },
    }));
    const responses: WorkerResponse[] = [];
    let receive!: (request: WorkerRequest) => void;
    wireWorker(lp, {
      post: (response) => responses.push(response),
      onMessage: (callback) => { receive = callback; },
    });

    receive({ id: 1, type: "load", buffer: new ArrayBuffer(4), w: 1, h: 1 });
    expect(responses.at(-1)).toMatchObject({ id: 1, ok: false });
    expect(destroyCalls).toBe(1);

    receive({ id: 2, type: "load", buffer: new ArrayBuffer(4), w: 1, h: 1 });
    expect(responses.at(-1)).toMatchObject({ id: 2, ok: true, type: "load" });
    receive({ id: 3, type: "close" });
    expect(destroyCalls).toBe(2);
  });

  it("keeps native handles opaque and rejects direct Pix construction", () => {
    const lp = new Leptonica(fakeModule());
    const pix = lp.fromRGBA(new Uint8Array(4), 1, 1);
    const PixCtor = pix.constructor as unknown as new (...args: unknown[]) => typeof pix;

    expect("module" in lp).toBe(false);
    expect("handle" in pix).toBe(false);
    expect(() => new PixCtor(fakeHandle(), lp)).toThrow(/cannot be constructed directly/);

    pix.dispose();
  });

  it("continues closing other Pix after an ordinary destructor failure", () => {
    const first = fakeHandle();
    const second = fakeHandle();
    const handles = [first, second];
    const destroyed: PixHandle[] = [];
    const lp = new Leptonica(fakeModule({
      fromRGBA: () => handles.shift() ?? fakeHandle(),
      destroyPix: (handle) => {
        if (handle === first) throw new Error("first destructor failed");
        if (handle !== null) destroyed.push(handle);
      },
    }));
    const a = lp.fromRGBA(new Uint8Array(4), 1, 1);
    const b = lp.fromRGBA(new Uint8Array(4), 1, 1);

    expect(() => lp.close()).toThrow(/first destructor failed/);
    expect(destroyed).toEqual([second]);
    expect(() => a.width).toThrow(ReferenceError);
    expect(() => b.width).toThrow(ReferenceError);
    expect(() => lp.close()).not.toThrow();
  });

  it("marks a worker trap as fatal and locks the arena until the client tears down", () => {
    let wasmEntries = 0;
    const lp = new Leptonica(fakeModule({
      fromRGBA: () => {
        wasmEntries++;
        throw new WebAssembly.RuntimeError("unreachable");
      },
    }));
    const responses: WorkerResponse[] = [];
    let receive!: (request: WorkerRequest) => void;
    wireWorker(lp, {
      post: (response) => responses.push(response),
      onMessage: (cb) => { receive = cb; },
    });

    receive({ id: 7, type: "load", buffer: new ArrayBuffer(4), w: 1, h: 1 });
    receive({ id: 8, type: "load", buffer: new ArrayBuffer(4), w: 1, h: 1 });

    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ id: 7, ok: false, fatal: true });
    expect(responses[1]).toMatchObject({ id: 8, ok: false, fatal: true });
    expect(wasmEntries).toBe(1);
  });

  it("treats a trap from a non-load request as session-fatal", () => {
    let queryEntries = 0;
    const lp = new Leptonica(fakeModule({
      countPixels: () => {
        queryEntries++;
        throw new WebAssembly.RuntimeError("unreachable");
      },
    }));
    const responses: WorkerResponse[] = [];
    let receive!: (request: WorkerRequest) => void;
    wireWorker(lp, {
      post: (response) => responses.push(response),
      onMessage: (cb) => { receive = cb; },
    });

    receive({ id: 9, type: "load", buffer: new ArrayBuffer(4), w: 1, h: 1 });
    expect(responses.at(-1)).toMatchObject({ id: 9, ok: true, type: "load", handle: 1 });

    receive({ id: 10, type: "query", handle: 1, query: { query: "countPixels" } });
    receive({ id: 11, type: "extract", handle: 1, format: "png" });

    expect(responses.at(-2)).toMatchObject({ id: 10, ok: false, fatal: true });
    expect(responses.at(-1)).toMatchObject({ id: 11, ok: false, fatal: true });
    expect(queryEntries).toBe(1);
  });

  it("poisons a client session on a fatal response but not on a normal error", async () => {
    const posted: WorkerRequest[] = [];
    let receive!: (response: WorkerResponse) => void;
    let teardownCalls = 0;
    const session = new WorkerSession(
      (request) => posted.push(request),
      (cb) => { receive = cb; },
      () => { teardownCalls++; },
    );

    const init = session.init();
    receive({ id: posted.at(-1)!.id, ok: true, type: "init" });
    await init;

    const recoverable = session.load(new Uint8Array(4), 1, 1);
    receive({ id: posted.at(-1)!.id, ok: false, error: "bad input" });
    await expect(recoverable).rejects.toThrow(/bad input/);
    expect(teardownCalls).toBe(0);

    const fatal = session.load(new Uint8Array(4), 1, 1);
    receive({
      id: posted.at(-1)!.id,
      ok: false,
      fatal: true,
      error: "RuntimeError: unreachable",
    });
    await expect(fatal).rejects.toThrow(/fatal WebAssembly trap/);
    expect(teardownCalls).toBe(1);
    const postsAfterFatal = posted.length;
    await expect(session.load(new Uint8Array(4), 1, 1)).rejects.toThrow(
      /WorkerSession is terminated/,
    );
    await expect(session.close()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted).toHaveLength(postsAfterFatal);
  });

  it("rejects every pending request when one request reports a fatal trap", async () => {
    const posted: WorkerRequest[] = [];
    let receive!: (response: WorkerResponse) => void;
    const session = new WorkerSession(
      (request) => posted.push(request),
      (cb) => { receive = cb; },
    );

    const init = session.init();
    receive({ id: posted.at(-1)!.id, ok: true, type: "init" });
    await init;

    const first = session.load(new Uint8Array(4), 1, 1);
    const firstId = posted.at(-1)!.id;
    const second = session.load(new Uint8Array(4), 1, 1);

    receive({ id: firstId, ok: false, fatal: true, error: "RuntimeError: unreachable" });

    await expect(first).rejects.toThrow(/fatal WebAssembly trap/);
    await expect(second).rejects.toThrow(/fatal WebAssembly trap/);
  });

  it("does not publish successful responses after same-turn fatal retirement", async () => {
    const posted: WorkerRequest[] = [];
    let receive!: (response: WorkerResponse) => void;
    let teardownCalls = 0;
    const session = new WorkerSession(
      (request) => posted.push(request),
      (cb) => { receive = cb; },
      () => { teardownCalls++; },
    );

    const init = session.init();
    receive({ id: posted.at(-1)!.id, ok: true, type: "init" });
    await init;

    const load = session.load(new Uint8Array(4), 1, 1);
    const loadId = posted.at(-1)!.id;
    const fatal = session.load(new Uint8Array(4), 1, 1);
    const fatalId = posted.at(-1)!.id;
    const loadRejected = expect(load).rejects.toThrow(/WorkerSession is terminated/);
    const fatalRejected = expect(fatal).rejects.toThrow(/fatal WebAssembly trap/);

    // A transport is allowed to deliver multiple responses synchronously. The
    // successful internal request must not publish a live proxy after the
    // following fatal control response has retired the whole session.
    receive({ id: loadId, ok: true, type: "load", handle: 1, width: 1, height: 1, depth: 32 });
    receive({ id: fatalId, ok: false, fatal: true, error: "RuntimeError: unreachable" });

    await loadRejected;
    await fatalRejected;
    expect(teardownCalls).toBe(1);
  });

  it("does not publish successful init after same-turn fatal retirement", async () => {
    const posted: WorkerRequest[] = [];
    let receive!: (response: WorkerResponse) => void;
    let teardownCalls = 0;
    const session = new WorkerSession(
      (request) => posted.push(request),
      (cb) => { receive = cb; },
      () => { teardownCalls++; },
    );

    const init = session.init();
    const initRejected = expect(init).rejects.toThrow(/WorkerSession is terminated/);
    receive({ id: posted.at(-1)!.id, ok: true, type: "init" });
    receive({ id: 999_999, ok: false, fatal: true, error: "RuntimeError: unreachable" });

    await initRejected;
    expect(teardownCalls).toBe(1);
  });

  it("gates every successful result shape against same-turn fatal retirement", async () => {
    const posted: WorkerRequest[] = [];
    let receive!: (response: WorkerResponse) => void;
    const session = new WorkerSession(
      (request) => posted.push(request),
      (cb) => { receive = cb; },
    );

    const init = session.init();
    receive({ id: posted.at(-1)!.id, ok: true, type: "init" });
    await init;

    const initial = session.load(new Uint8Array(4), 1, 1);
    receive({ id: posted.at(-1)!.id, ok: true, type: "load", handle: 1, width: 1, height: 1, depth: 32 });
    const pix = await initial;

    const run = session.run(pix, []);
    const runId = posted.at(-1)!.id;
    const extract = session.extract(pix, "rgba");
    const extractId = posted.at(-1)!.id;
    const query = session.query(pix, { query: "countPixels" });
    const queryId = posted.at(-1)!.id;
    const fatal = session.load(new Uint8Array(4), 1, 1);
    const fatalId = posted.at(-1)!.id;
    const results = [run, extract, query].map((promise) =>
      expect(promise).rejects.toThrow(/WorkerSession is terminated/),
    );
    const fatalRejected = expect(fatal).rejects.toThrow(/fatal WebAssembly trap/);

    receive({ id: runId, ok: true, type: "run", handle: 2, width: 1, height: 1, depth: 32 });
    receive({ id: extractId, ok: true, type: "extract", buffer: new Uint8Array([1, 2, 3, 4]).buffer });
    receive({ id: queryId, ok: true, type: "query", value: { kind: "countPixels", count: 1 } });
    receive({ id: fatalId, ok: false, fatal: true, error: "RuntimeError: unreachable" });

    await Promise.all(results);
    await fatalRejected;
  });

  it("does not publish a successful handle after close starts", async () => {
    const posted: WorkerRequest[] = [];
    let receive!: (response: WorkerResponse) => void;
    let teardownCalls = 0;
    const session = new WorkerSession(
      (request) => posted.push(request),
      (cb) => { receive = cb; },
      () => { teardownCalls++; },
    );

    const init = session.init();
    receive({ id: posted.at(-1)!.id, ok: true, type: "init" });
    await init;

    const load = session.load(new Uint8Array(4), 1, 1);
    const loadId = posted.at(-1)!.id;
    const closed = session.close();
    const closeId = posted.at(-1)!.id;
    const loadRejected = expect(load).rejects.toThrow(/WorkerSession is closed/);

    receive({ id: loadId, ok: true, type: "load", handle: 1, width: 1, height: 1, depth: 32 });
    receive({ id: closeId, ok: true, type: "close" });

    await loadRejected;
    await closed;
    expect(teardownCalls).toBe(1);
  });

  it("retires a session even when a fatal response arrives for a stale request id", async () => {
    const posted: WorkerRequest[] = [];
    let receive!: (response: WorkerResponse) => void;
    let teardownCalls = 0;
    const session = new WorkerSession(
      (request) => posted.push(request),
      (cb) => { receive = cb; },
      () => { teardownCalls++; },
    );

    const init = session.init();
    receive({ id: posted.at(-1)!.id, ok: true, type: "init" });
    await init;

    receive({ id: 999_999, ok: false, fatal: true, error: "RuntimeError: unreachable" });

    expect(teardownCalls).toBe(1);
    await expect(session.load(new Uint8Array(4), 1, 1)).rejects.toThrow(
      /WorkerSession is terminated/,
    );
  });
});
