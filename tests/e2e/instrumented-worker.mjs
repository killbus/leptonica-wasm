/**
 * CI-only browser Worker entry for fatal-retirement evidence. It loads the
 * separately built instrumented module, arms a real __builtin_trap(), then
 * delegates request handling to the production WorkerArena/wire protocol.
 * Nothing in this file is part of the published package.
 */
import leptonicaFactory from "../../dist-instrumented/leptonica.mjs";
import { isFatalWasmTrap, Leptonica } from "../../src/core/types.ts";
import { wireWorker } from "../../src/worker/arena.ts";

const ctx = self;
let booted = false;

const surface = {
  post: (message, transfer) => ctx.postMessage(message, transfer),
  onMessage: (callback) => {
    ctx.onmessage = (event) => callback(event.data);
  },
};

surface.onMessage(async (request) => {
  const replyError = (error) => surface.post({ id: request.id, ok: false, error });
  if (request.type !== "init") {
    replyError("worker: not initialized (init required first)");
    return;
  }
  if (booted) {
    replyError("worker: already initialized (init is single-shot)");
    return;
  }
  booted = true;

  try {
    const moduleArg = {};
    if (request.wasmPath !== undefined) moduleArg.locateFile = () => request.wasmPath;
    const module = await leptonicaFactory(moduleArg);
    if (ctx.name === "fatalTrap") module.testArmFault("fatalTrap");
    wireWorker(new Leptonica(module), surface);
    surface.post({ id: request.id, ok: true, type: "init" });
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    surface.post({
      id: request.id,
      ok: false,
      ...(isFatalWasmTrap(error) ? { fatal: true } : {}),
      error: message,
    });
  }
});
