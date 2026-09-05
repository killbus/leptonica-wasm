/**
 * Node worker_threads adapter (design §5.3).
 *
 * createSession() must work unchanged in Node and the browser: the
 * browser branch resolves the worker entry through a bundler-friendly
 * new URL(...) pattern, which Node's ESM loader cannot execute as a
 * worker script (it needs a real file URL, and the .TS source form is
 * not loadable at all). This module resolves both paths explicitly
 * against the package layout on disk and bridges worker_threads'
 * message shapes onto the session's postMessage transport.
 */

import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerRequest, WorkerResponse } from "./protocol.ts";
import { WorkerSession } from "./session.ts";
import type { SessionOptions } from "./session.ts";

/**
 * Locate the worker entry relative to this compiled file inside the
 * package (dist/types/worker/node.js → dist/worker.mjs).
 */
function resolveEntry(): URL {
  const here = dirname(new URL(import.meta.url).pathname);
  const entry = join(here, "..", "..", "..", "worker.mjs");
  return pathToFileURL(entry);
}

/** Create a session backed by a worker_threads Worker (Node ≥ 20). */
export async function createSession(_opts?: SessionOptions): Promise<WorkerSession> {
  const entry = resolveEntry();
  // .mjs entry → ESM; worker_threads infers module type from the extension.
  const worker = new Worker(entry);
  const session = new WorkerSession(
    (msg: WorkerRequest, transfer?: Transferable[]) => {
      worker.postMessage(msg, (transfer ?? []).map((t) => (t instanceof ArrayBuffer ? t : (t as unknown as import("node:worker_threads").MessagePort))));
    },
    (cb) => {
      worker.on("message", (r: WorkerResponse) => cb(r));
    },
  );
  worker.once("exit", () => session.markTerminated());
  worker.once("error", () => session.markTerminated());
  return session;
}
