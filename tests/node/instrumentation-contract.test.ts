import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const build = readFileSync("scripts/build.mjs", "utf8");
const bindings = readFileSync("cpp/bindings.cpp", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const packageContract = readFileSync("scripts/check-package-contract.mjs", "utf8");
const browserFaultWorker = readFileSync("tests/e2e/instrumented-worker.mjs", "utf8");
const browserFaultPage = readFileSync("tests/e2e/fatal-page.mjs", "utf8");
const browserSpec = readFileSync("tests/e2e/e2e.browser.spec.ts", "utf8");

describe("CI-only native fault instrumentation contract", () => {
  it("uses an explicit isolated build flavor", () => {
    expect(build).toContain("--test-instrumentation");
    expect(build).toContain("tmp/build-instrumented");
    expect(build).toContain("dist-instrumented");
    expect(build).toContain("--test-instrumentation cannot be combined with --full-abi");
    expect(build).toContain("--test-instrumentation output must be outside the production dist tree");
  });

  it("rejects conflicting modes and production output paths before building", () => {
    const conflict = spawnSync(
      process.execPath,
      ["scripts/build.mjs", "--full-abi", "--test-instrumentation"],
      { encoding: "utf8" },
    );
    expect(conflict.status).toBe(2);
    expect(conflict.stderr).toContain(
      "--test-instrumentation cannot be combined with --full-abi",
    );

    const productionOut = spawnSync(
      process.execPath,
      ["scripts/build.mjs", "--test-instrumentation", "--outdir", "dist/test-hooks"],
      { encoding: "utf8" },
    );
    expect(productionOut.status).toBe(2);
    expect(productionOut.stderr).toContain(
      "--test-instrumentation output must be outside the production dist tree",
    );
  });

  it("intercepts Leptonica allocations only in the instrumented flavor", () => {
    expect(build).toContain("-DLEPTONICA_INTERCEPT_ALLOC");
    expect(build).toContain("-DLEPTONICA_WASM_TEST_INSTRUMENTATION");
    expect(bindings).toContain("#ifdef LEPTONICA_WASM_TEST_INSTRUMENTATION");
    expect(bindings).toContain("leptonica_malloc");
    expect(bindings).toContain("testAllocationStats");
    expect(bindings).toContain("testArmAllocationFailure");
    expect(bindings).toContain("testArmFault");
    expect(bindings).toContain('consumeTestFault("fatalTrap")');
  });

  it("makes the instrumented runtime suite mandatory in CI", () => {
    expect(ci).toContain("node scripts/build.mjs --test-instrumentation");
    expect(ci).toContain("test -f dist-instrumented/leptonica.mjs");
    expect(ci).toContain("test -f dist-instrumented/leptonica.wasm");
    expect(ci).toContain("test -f dist-instrumented/leptonica.d.ts");
    expect(ci).toContain("tests/node/fault-injection.test.ts");
    expect(browserFaultWorker).toContain('../../dist-instrumented/leptonica.mjs');
    expect(browserFaultWorker).toContain('testArmFault("fatalTrap")');
    expect(browserSpec).toContain("target-WASM trap");
    expect(browserFaultPage).toContain("createSession as createBrowserSession");
    expect(browserFaultPage).toContain('from "leptonica-wasm/worker"');
    expect(browserFaultPage).toContain("adapterTeardownCalls");
    expect(browserFaultPage).toContain("post-fatal worker probe");
    expect(ci.match(/test -f dist-instrumented\/leptonica\.wasm/g)).toHaveLength(2);
  });

  it("rejects test hooks from production package artifacts", () => {
    expect(packageContract).toContain("testAllocationStats");
    expect(packageContract).toContain("testArmAllocationFailure");
    expect(packageContract).toContain("testArmFault");
  });
});
