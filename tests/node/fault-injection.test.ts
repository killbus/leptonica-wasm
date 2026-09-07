import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { generateRgba } from "../../scripts/generate-rgba.mjs";
import { Leptonica, type Pix } from "../../src/core/types.ts";
import type { CuratedModule } from "../../src/core/emscripten-glue-shape.d.ts";

interface AllocationStats {
  readonly liveBlocks: number;
  readonly liveBytes: number;
  readonly allocationAttempts: number;
}

interface AllocationSweepFixture {
  run(): unknown;
  disposeResult(result: unknown): void;
  dispose(): void;
}

type FaultName =
  | "copyJsBytesToWasm"
  | "copyWasmBytesToJs"
  | "sauvola.partial"
  | "sauvolaTiled.partial"
  | "fatalTrap";

type InstrumentedModule = CuratedModule & {
  testAllocationStats(): AllocationStats;
  testArmAllocationFailure(successfulAllocationsBeforeFailure: number): void;
  testArmFault(name: FaultName): void;
  testClearFaults(): void;
};

const instrumentedMjs = resolve("dist-instrumented/leptonica.mjs");
const instrumentedWasm = resolve("dist-instrumented/leptonica.wasm");
const productionMjs = resolve("dist/leptonica.mjs");
const productionWasm = resolve("dist/leptonica.wasm");
const instrumentedBuildPresent =
  existsSync(instrumentedMjs) && existsSync(instrumentedWasm);
const productionBuildPresent = existsSync(productionMjs) && existsSync(productionWasm);

async function loadModule<T extends CuratedModule>(
  mjsPath: string,
  wasmPath: string,
): Promise<T> {
  const imported = (await import(pathToFileURL(mjsPath).href)) as {
    default: (options: { wasmBinary: Uint8Array }) => Promise<T>;
  };
  return imported.default({ wasmBinary: readFileSync(wasmPath) });
}

async function loadInstrumented(): Promise<{
  readonly lp: Leptonica;
  readonly module: InstrumentedModule;
}> {
  const module = await loadModule<InstrumentedModule>(instrumentedMjs, instrumentedWasm);
  return { lp: new Leptonica(module), module };
}

function live(stats: AllocationStats): Pick<AllocationStats, "liveBlocks" | "liveBytes"> {
  return { liveBlocks: stats.liveBlocks, liveBytes: stats.liveBytes };
}

function expectLiveAt(
  module: InstrumentedModule,
  baseline: Pick<AllocationStats, "liveBlocks" | "liveBytes">,
): void {
  expect(live(module.testAllocationStats())).toEqual(baseline);
}

function sweepObservedAllocations(
  module: InstrumentedModule,
  fixture: AllocationSweepFixture,
): void {
  const warm = fixture.run();
  fixture.disposeResult(warm);
  const baseline = live(module.testAllocationStats());

  const attemptsBeforeProbe = module.testAllocationStats().allocationAttempts;
  const probe = fixture.run();
  const allocationCount =
    module.testAllocationStats().allocationAttempts - attemptsBeforeProbe;
  fixture.disposeResult(probe);
  expect(allocationCount).toBeGreaterThan(0);
  expectLiveAt(module, baseline);

  let observedFailures = 0;
  for (let failureIndex = 0; failureIndex < allocationCount; failureIndex++) {
    module.testArmAllocationFailure(failureIndex);
    let output: unknown;
    let hasOutput = false;
    try {
      output = fixture.run();
      hasOutput = true;
    } catch {
      observedFailures++;
    } finally {
      if (hasOutput) fixture.disposeResult(output);
      module.testClearFaults();
    }
    expectLiveAt(module, baseline);
  }
  expect(observedFailures).toBeGreaterThan(0);

  const recovered = fixture.run();
  fixture.disposeResult(recovered);
  expectLiveAt(module, baseline);
}

const allocationSweepCases: ReadonlyArray<{
  readonly name: string;
  setup(lp: Leptonica): AllocationSweepFixture;
}> = [
  {
    name: "fromRGBA",
    setup: (lp) => ({
      run: () => lp.fromRGBA(generateRgba(32, 32), 32, 32),
      disposeResult: (result) => (result as Pix).dispose(),
      dispose: () => undefined,
    }),
  },
  {
    name: "cleanBackgroundToWhite",
    setup: (lp) => {
      const source = lp.fromRGBA(generateRgba(64, 64), 64, 64);
      return {
        run: () => lp.chain(source).cleanBackgroundToWhite(1, 70, 190).run(),
        disposeResult: (result) => (result as Pix).dispose(),
        dispose: () => source.dispose(),
      };
    },
  },
  {
    name: "sauvolaTiled",
    setup: (lp) => {
      const source = lp.fromRGBA(generateRgba(64, 64), 64, 64);
      const gray = lp.chain(source).toGray().run();
      source.dispose();
      return {
        run: () => lp.chain(gray).sauvolaTiled(4, 0.34, 1, 1).run(),
        disposeResult: (result) => (result as Pix).dispose(),
        dispose: () => gray.dispose(),
      };
    },
  },
  {
    name: "selectByArea",
    setup: (lp) => {
      const source = lp.fromRGBA(generateRgba(64, 64), 64, 64);
      const binary = lp.chain(source).toGray().threshold(128).run();
      source.dispose();
      return {
        run: () => lp.chain(binary).selectByArea(3, 4, "gt").run(),
        disposeResult: (result) => (result as Pix).dispose(),
        dispose: () => binary.dispose(),
      };
    },
  },
  {
    name: "maskOverColorPixels",
    setup: (lp) => {
      const source = lp.fromRGBA(generateRgba(64, 64), 64, 64);
      return {
        run: () => lp.chain(source).maskOverColorPixels(20, 3).run(),
        disposeResult: (result) => (result as Pix).dispose(),
        dispose: () => source.dispose(),
      };
    },
  },
  {
    name: "toMask",
    setup: (lp) => {
      const source = lp.fromRGBA(generateRgba(64, 64), 64, 64);
      const binary = lp.chain(source).toGray().threshold(128).run();
      source.dispose();
      return {
        run: () => binary.toMask(),
        disposeResult: () => undefined,
        dispose: () => binary.dispose(),
      };
    },
  },
];

describe.skipIf(!instrumentedBuildPresent)("instrumented native failure paths", () => {
  it.skipIf(!productionBuildPresent)(
    "matches the production artifact without exposing hooks there",
    async () => {
      const input = generateRgba(64, 64);
      const instrumented = await loadInstrumented();
      const productionModule = await loadModule<CuratedModule>(
        productionMjs,
        productionWasm,
      );
      const production = new Leptonica(productionModule);

      expect("testAllocationStats" in productionModule).toBe(false);
      using instrumentedSource = instrumented.lp.fromRGBA(input, 64, 64);
      using productionSource = production.fromRGBA(input, 64, 64);
      using instrumentedOutput = instrumented.lp
        .chain(instrumentedSource)
        .toGray()
        .sauvolaTiled(4, 0.34, 1, 1)
        .selectByArea(3, 4, "gt")
        .run();
      using productionOutput = production
        .chain(productionSource)
        .toGray()
        .sauvolaTiled(4, 0.34, 1, 1)
        .selectByArea(3, 4, "gt")
        .run();

      expect(instrumentedOutput.toMask()).toEqual(productionOutput.toMask());
    },
  );

  it("releases a partially-created PIX when fromRGBA input copying fails", async () => {
    const { lp, module } = await loadInstrumented();
    const baseline = live(module.testAllocationStats());

    module.testArmFault("copyJsBytesToWasm");
    expect(() => lp.fromRGBA(generateRgba(32, 32), 32, 32)).toThrow(
      /fromRGBA: allocation failed/,
    );
    expectLiveAt(module, baseline);

    module.testClearFaults();
    const recovered = lp.fromRGBA(generateRgba(32, 32), 32, 32);
    recovered.dispose();
    expectLiveAt(module, baseline);
    lp.close();
  });

  it("frees temporary native output buffers when JS extraction fails", async () => {
    const { lp, module } = await loadInstrumented();
    using src = lp.fromRGBA(generateRgba(48, 48), 48, 48);
    using binary = lp.chain(src).toGray().threshold(128).run();

    for (const extract of [
      { name: "toRGBA", run: () => src.toRGBA() },
      { name: "toMask", run: () => binary.toMask() },
      { name: "toPNG", run: () => src.toPNG() },
      { name: "toJPEG", run: () => src.toJPEG(80) },
    ]) {
      // Warm codec/global state before taking the leak baseline. A library's
      // intentional one-time initialization is not a per-call ownership leak.
      expect(extract.run(), extract.name).toBeDefined();
      const baseline = live(module.testAllocationStats());
      module.testArmFault("copyWasmBytesToJs");
      expect(extract.run, extract.name).toThrow();
      expectLiveAt(module, baseline);
      module.testClearFaults();
      expect(extract.run(), extract.name).toBeInstanceOf(
        extract.name === "toMask" ? Object : Uint8Array,
      );
      expectLiveAt(module, baseline);
    }
  });

  it.each([
    { fault: "sauvola.partial" as const, tiled: false },
    { fault: "sauvolaTiled.partial" as const, tiled: true },
  ])("destroys the output assigned before $fault reports failure", async ({ fault, tiled }) => {
    const { lp, module } = await loadInstrumented();
    using src = lp.fromRGBA(generateRgba(64, 64), 64, 64);
    using gray = lp.chain(src).toGray().run();
    const baseline = live(module.testAllocationStats());

    module.testArmFault(fault);
    const run = () =>
      tiled
        ? lp.chain(gray).sauvolaTiled(4, 0.34, 1, 1).run()
        : lp.chain(gray).sauvola(4, 0.34).run();
    expect(run).toThrow(/returned null/);
    expectLiveAt(module, baseline);

    module.testClearFaults();
    const recovered = run();
    recovered.dispose();
    expectLiveAt(module, baseline);
  });

  it("cleans earlier chain intermediates when a later operator fails", async () => {
    const { lp, module } = await loadInstrumented();
    using src = lp.fromRGBA(generateRgba(64, 64), 64, 64);
    const baseline = live(module.testAllocationStats());

    module.testArmFault("sauvola.partial");
    expect(() => lp.chain(src).toGray().sauvola(4, 0.34).run()).toThrow(
      /returned null/,
    );
    expectLiveAt(module, baseline);

    module.testClearFaults();
    using recovered = lp.chain(src).toGray().sauvola(4, 0.34).run();
    expect(recovered.depth).toBe(1);
  });

  it.each(allocationSweepCases)(
    "sweeps every observed $name allocation point and remains reusable",
    async ({ setup }) => {
    const { lp, module } = await loadInstrumented();
      const initial = live(module.testAllocationStats());
      const fixture = setup(lp);
      try {
        sweepObservedAllocations(module, fixture);
        fixture.dispose();
        expectLiveAt(module, initial);
      } finally {
        module.testClearFaults();
        fixture.dispose();
        lp.close();
      }
    },
  );

  it("retires the direct instance after an actual injected WASM trap", async () => {
    const { lp, module } = await loadInstrumented();
    const source = lp.fromRGBA(generateRgba(16, 16), 16, 16);

    module.testArmFault("fatalTrap");
    expect(() => lp.fromRGBA(generateRgba(16, 16), 16, 16)).toThrow(
      WebAssembly.RuntimeError,
    );

    // The trapped heap is abandoned: existing wrappers are poisoned, new
    // calls are rejected before entering WASM, and close() performs no native
    // destructor calls against the retired instance.
    expect(() => source.width).toThrow(ReferenceError);
    expect(() => lp.fromRGBA(generateRgba(16, 16), 16, 16)).toThrow(
      /retired after a fatal WebAssembly trap/,
    );
    expect(() => lp.close()).not.toThrow();

    // Retirement is instance-scoped; a fresh module remains usable.
    const fresh = await loadInstrumented();
    const recovered = fresh.lp.fromRGBA(generateRgba(16, 16), 16, 16);
    recovered.dispose();
    fresh.lp.close();
  });
});
