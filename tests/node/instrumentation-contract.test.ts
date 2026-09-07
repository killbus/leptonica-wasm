import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

const build = readFileSync("scripts/build.mjs", "utf8");
const bindings = readFileSync("cpp/bindings.cpp", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const packageContract = readFileSync("scripts/check-package-contract.mjs", "utf8");
const browserFaultWorker = readFileSync("tests/e2e/instrumented-worker.mjs", "utf8");
const browserFaultPage = readFileSync("tests/e2e/fatal-page.mjs", "utf8");
const browserSpec = readFileSync("tests/e2e/e2e.browser.spec.ts", "utf8");
const browserViteConfig = readFileSync("tests/e2e/vite.config.mjs", "utf8");
const executableBindings = bindings
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

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
    expect(bindings).toContain('consumeTestFault("jpeg.destinationGrow")');
    expect(bindings).toContain('consumeTestFault("fatalTrap")');
  });

  it("keeps the curated JPEG path compression-only at the binding call site", () => {
    // The rebuilt symbol-map gate remains authoritative. This earlier source
    // check makes a direct regression to Leptonica's mixed JPEG read/write
    // translation unit fail without pretending to prove linker reachability.
    expect(executableBindings).not.toMatch(/\bpixWriteMemJpeg\s*\(/);
    expect(executableBindings).toMatch(/\bjpeg_create_compress\s*\(/);
    expect(executableBindings).toMatch(/\bjpeg_write_scanlines\s*\(/);
    expect(executableBindings).toMatch(/\bjpeg_finish_compress\s*\(/);
    expect(executableBindings).toMatch(/\bjpeg_destroy_compress\s*\(/);
  });

  it("cuts desktop debug display from curated links without changing full ABI", () => {
    expect(build).toMatch(
      /if \(!fullAbi\) \{[\s\S]*?"-DLEPTONICA_WASM_CURATED_NO_DISPLAY"[\s\S]*?"-Wl,--wrap=pixDisplay"[\s\S]*?\}/,
    );
    expect(bindings).toContain('#ifdef LEPTONICA_WASM_CURATED_NO_DISPLAY');
    expect(executableBindings).toMatch(
      /extern \"C\" l_ok __wrap_pixDisplay\(PIX \*, l_int32, l_int32\) \{\s*return 0;\s*\}/,
    );
    expect(executableBindings).not.toMatch(
      /extern \"C\" l_ok pixDisplay\(PIX \*, l_int32, l_int32\)/,
    );
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
    expect(browserViteConfig).toContain('packageJson.exports["./worker"]?.default?.import');
    expect(browserViteConfig).toContain("/^leptonica-wasm\\/worker$/");
    expect(browserViteConfig).toContain('exclude: ["leptonica-wasm/worker"]');
    expect(ci).toContain("test -f dist/types/worker/index.js");
    expect(ci).toContain("test -f dist/types/worker/worker.mjs");
    expect(ci.match(/test -f dist-instrumented\/leptonica\.wasm/g)).toHaveLength(2);
  });

  it("resolves the browser E2E import to the package's default worker export", async () => {
    // Vite does not implement package self-reference resolution for this
    // nested dev-server root. Exercise the real plugin container so this
    // cannot regress to a source-only assertion that still serves HTTP 500.
    const server = await createServer({
      configFile: resolve("tests/e2e/vite.config.mjs"),
      server: { middlewareMode: true },
      logLevel: "silent",
    });
    try {
      const resolved = await server.pluginContainer.resolveId(
        "leptonica-wasm/worker",
        resolve("tests/e2e/fatal-page.mjs"),
      );
      expect(resolved?.id).toBe(resolve("dist/types/worker/index.js"));
    } finally {
      await server.close();
    }
  });

  it("rejects test hooks from production package artifacts", () => {
    expect(packageContract).toContain("testAllocationStats");
    expect(packageContract).toContain("testArmAllocationFailure");
    expect(packageContract).toContain("testArmFault");
  });
});
