/**
 * The worker entry (design §5.3) — runs INSIDE the worker thread.
 *
 * One Leptonica instance per worker (decision ⑧: Leptonica has global
 * state, one-instance-per-worker is the safety model). The wasm binary
 * is located relative to this file by default; the session client can
 * override the location via the init handshake or wasmPath option.
 */

import { WorkerSession } from "./session.ts";

declare const self: {
  onmessage: ((ev: { data: unknown }) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

// Placeholder — replaced by the implementation.
export const SESSION = null as unknown as WorkerSession | null;
