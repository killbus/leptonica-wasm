/**
 * Browser worker session client (design §5.3).
 *
 * The worker entry is resolved through the standard bundler-friendly
 * pattern (new URL + import.meta.url); every major bundler rewrites it
 * at build time to a worker chunk. Node resolves "leptonica-wasm/worker"
 * to the worker_threads adapter through the "node" export condition —
 * the same specifier serves both platforms.
 */

import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { WorkerSession } from "./session.ts";
import type { SessionOptions } from "./session.ts";

/** Create a session backed by a DOM Worker. */
export async function createSession(opts: SessionOptions = {}): Promise<WorkerSession> {
  // The bundler rewrites this to a worker chunk URL at build time.
  // NOTE: the constructor must appear literally as `new Worker(...)` —
  // bundlers (vite) detect exactly that shape to emit a bundled worker
  // chunk. A globalThis.Worker lookup defeats the detection and the
  // entry gets copied as a raw asset instead.
  const domWorker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
  // Narrow to the postMessage(msg, transfer[]) shape the session uses;
  // the DOM lib types the second argument as StructuredSerializeOptions.
  const worker: {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    addEventListener(type: "message", cb: (ev: { data: WorkerResponse }) => void): void;
    addEventListener(type: "error", cb: (ev: unknown) => void): void;
    addEventListener(type: "messageerror", cb: (ev: unknown) => void): void;
    terminate(): void;
  } = domWorker;
  const session = new WorkerSession(
    (msg: WorkerRequest, transfer?: Transferable[]) => {
      worker.postMessage(msg, transfer);
    },
    (cb) => {
      worker.addEventListener("message", (ev) => cb(ev.data));
    },
    // Symmetric with the Node adapter: release the platform worker once
    // the session is dead. DOM Workers are GC-able, but explicit
    // teardown keeps the no-residue contract observable.
    () => worker.terminate(),
  );
  worker.addEventListener("error", () => session.markTerminated());
  worker.addEventListener("messageerror", () => session.markTerminated(new Error("worker message deserialization failed")));
  try {
    await session.init(opts.wasmPath);
  } catch (err) {
    // Route initialization failures through the session's idempotent
    // retirement gate. A fatal init response has already called the same
    // teardown; terminating the native Worker directly here would do it
    // twice. Ordinary init failures still retire and release it once.
    session.terminate();
    throw err;
  }
  return session;
}

export { WorkerSession, RemotePix } from "./session.ts";
export type { SessionOptions } from "./session.ts";
export type { PackedMask } from "../core/types.ts";
