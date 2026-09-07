import { createSession as createBrowserSession } from "leptonica-wasm/worker";
import { WorkerSession } from "../../src/worker/session.ts";

const NativeWorker = globalThis.Worker;

function rgbaPixel() {
  return new Uint8Array([0, 0, 0, 255]);
}

function within(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
    }),
  ]);
}

function newInstrumentedWorker(fault) {
  // The entry URL stays literal for Vite's worker transform. The standard
  // Worker name is test-only metadata and survives bundling without adding a
  // fault-control message to the package protocol.
  return new NativeWorker(new URL("./instrumented-worker.mjs", import.meta.url), {
    type: "module",
    name: fault ?? "control",
  });
}

async function openProductionAdapterSession(fault) {
  let worker;
  let firstFatalMessage;
  let adapterTeardownCalls = 0;
  let adapterPostCalls = 0;

  // Exercise the production browser adapter unchanged. The constructor shim
  // substitutes only the CI-only instrumented Worker entry; createSession()
  // still owns transport listeners and its real `() => worker.terminate()`
  // teardown callback. The wrapped native method proves that callback runs.
  function InstrumentedWorkerForAdapter() {
    worker = newInstrumentedWorker(fault);
    worker.addEventListener("message", (event) => {
      if (firstFatalMessage === undefined && event.data?.fatal === true) {
        firstFatalMessage = event.data;
      }
    });
    const nativePostMessage = worker.postMessage.bind(worker);
    const nativeTerminate = worker.terminate.bind(worker);
    Object.defineProperty(worker, "postMessage", {
      configurable: true,
      value: (message, transfer) => {
        adapterPostCalls++;
        nativePostMessage(message, transfer);
      },
    });
    Object.defineProperty(worker, "terminate", {
      configurable: true,
      value: () => {
        adapterTeardownCalls++;
        nativeTerminate();
      },
    });
    return worker;
  }

  globalThis.Worker = InstrumentedWorkerForAdapter;
  try {
    const session = await createBrowserSession();
    return {
      session,
      worker,
      firstFatal: () => firstFatalMessage,
      adapterPostCalls: () => adapterPostCalls,
      adapterTeardownCalls: () => adapterTeardownCalls,
    };
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

async function openTerminalGateProbeSession() {
  const worker = newInstrumentedWorker("fatalTrap");
  const messages = [];
  const waiters = new Map();
  let teardownCalls = 0;

  worker.addEventListener("message", (event) => {
    messages.push(event.data);
    const waiter = waiters.get(event.data.id);
    if (waiter !== undefined) {
      waiters.delete(event.data.id);
      waiter(event.data);
    }
  });

  const session = new WorkerSession(
    (message, transfer) => worker.postMessage(message, transfer),
    (callback) => worker.addEventListener("message", (event) => callback(event.data)),
    // This second session deliberately delays physical termination so the
    // test can inspect the worker-side terminal gate. Production teardown is
    // exercised independently by openProductionAdapterSession() above.
    () => { teardownCalls++; },
  );
  worker.addEventListener("error", () => session.markTerminated());
  worker.addEventListener("messageerror", () => session.markTerminated(new Error("worker message deserialization failed")));
  await session.init();

  return {
    session,
    worker,
    teardownCalls: () => teardownCalls,
    firstFatal: () => messages.find((message) => message.fatal === true),
    waitForId(id) {
      const found = messages.find((message) => message.id === id);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve) => waiters.set(id, resolve));
    },
  };
}

async function runFatalRetirement() {
  const trapped = await openProductionAdapterSession("fatalTrapAfterLoad");
  try {
    const live = await trapped.session.load(rgbaPixel(), 1, 1);
    const first = trapped.session.load(rgbaPixel(), 1, 1);
    const second = trapped.session.load(rgbaPixel(), 1, 1);
    const settled = await within(Promise.allSettled([first, second]), 2_000, "fatal pending requests");
    const productionFatal = trapped.firstFatal();
    if (productionFatal?.fatal !== true) {
      throw new Error("production adapter did not observe a fatal Worker response");
    }

    const postCallsBeforeLater = trapped.adapterPostCalls();
    let liveError = "";
    try {
      await live.toRGBA();
    } catch (error) {
      liveError = String(error);
    }
    let laterError = "";
    try {
      await trapped.session.load(rgbaPixel(), 1, 1);
    } catch (error) {
      laterError = String(error);
    }
    const postCallsAfterLater = trapped.adapterPostCalls();

    // Let delayed Worker error/message tasks drain, then exercise both public
    // cleanup paths. Fatal retirement must keep physical teardown idempotent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await trapped.session.close();
    trapped.session.terminate();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const postCallsAfterDrain = trapped.adapterPostCalls();

    return {
      pending: settled.map((result) => ({
        status: result.status,
        reason: result.status === "rejected" ? String(result.reason) : "unexpected fulfillment",
      })),
      livePoisoned: live.isPoisoned(),
      liveError,
      laterError,
      postCallsBeforeLater,
      postCallsAfterLater,
      postCallsAfterDrain,
      adapterTeardownCalls: trapped.adapterTeardownCalls(),
      productionEvidence: productionFatal.testFatalEvidence,
    };
  } finally {
    // Normally the production adapter already terminated it on the fatal
    // signal. This branch only prevents a leaked Worker if setup/assertion
    // fails before the fatal path is reached.
    if (trapped.adapterTeardownCalls() === 0) trapped.worker.terminate();
  }
}

async function runTerminalGateProbe() {
  const trapped = await openTerminalGateProbeSession();
  try {
    let initialError = "";
    await within(
      trapped.session.load(rgbaPixel(), 1, 1).then(
        () => { throw new Error("fatal trap unexpectedly fulfilled"); },
        (error) => { initialError = String(error); },
      ),
      2_000,
      "terminal gate trap",
    );
    const initialFatal = trapped.firstFatal();
    if (initialFatal?.fatal !== true || !initialError.includes("fatal WebAssembly trap")) {
      throw new Error(`initial request did not establish fatal retirement: ${initialError}`);
    }

    const probeId = 999_999;
    const probe = within(trapped.waitForId(probeId), 1_000, "post-fatal worker probe");
    const buffer = rgbaPixel().buffer;
    trapped.worker.postMessage({ id: probeId, type: "load", buffer, w: 1, h: 1 }, [buffer]);
    const response = await probe;
    return {
      teardownCalls: trapped.teardownCalls(),
      initialEvidence: initialFatal?.testFatalEvidence,
      probe: {
        ok: response.ok,
        fatal: response.fatal === true,
        evidence: response.testFatalEvidence,
      },
    };
  } finally {
    trapped.worker.terminate();
  }
}

async function runFreshRecovery() {
  const fresh = await openProductionAdapterSession();
  let dimensions;
  try {
    const pix = await fresh.session.load(rgbaPixel(), 1, 1);
    dimensions = { width: pix.width, height: pix.height, depth: pix.depth };
  } finally {
    await fresh.session.close();
  }
  return { ...dimensions, freshAdapterTeardownCalls: fresh.adapterTeardownCalls() };
}

window.__fatalE2eResult = (async () => {
  try {
    const fatal = await runFatalRetirement();
    const terminal = await runTerminalGateProbe();
    const fresh = await runFreshRecovery();
    return {
      ok: true,
      fatal: {
        ...fatal,
        terminalGateTeardownCalls: terminal.teardownCalls,
        terminalEvidence: terminal.initialEvidence,
        probe: terminal.probe,
      },
      fresh,
    };
  } catch (error) {
    return { ok: false, error: String(error && error.stack || error) };
  }
})();
