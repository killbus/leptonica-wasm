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

function workflowJob(name: string): string {
  const startMarker = `  ${name}:`;
  const start = ci.indexOf(startMarker);
  expect(start, `missing workflow job ${name}`).toBeGreaterThan(-1);
  const remainder = ci.slice(start + startMarker.length);
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\s*$/m);
  return nextJob === -1 ? ci.slice(start) : ci.slice(start, start + startMarker.length + nextJob);
}

function workflowStep(job: string, name: string): string {
  const startMarker = `      - name: ${name}`;
  const start = job.indexOf(startMarker);
  expect(start, `missing workflow step ${name}`).toBeGreaterThan(-1);
  const remainder = job.slice(start + startMarker.length);
  const nextStep = remainder.search(/^      - name:/m);
  return nextStep === -1
    ? job.slice(start)
    : job.slice(start, start + startMarker.length + nextStep);
}

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
    expect(bindings).toContain("testRecordFatalTrap");
    expect(bindings).toContain("__leptonicaWasmFatalTrapCount");
    expect(executableBindings).toMatch(
      /consumeTestFault\("fatalTrap"\)[\s\S]*?testRecordFatalTrap\(\)[\s\S]*?__builtin_trap\(\)/,
    );
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

  it("cuts desktop-only debug and file sinks from curated links without changing full ABI", () => {
    expect(build).toMatch(
      /if \(!fullAbi\) \{[\s\S]*?"-DLEPTONICA_WASM_CURATED_NO_DESKTOP_IO"[\s\S]*?"-Wl,--wrap=pixDisplay"[\s\S]*?"-Wl,--wrap=convertFilesToPdf"[\s\S]*?"-Wl,--wrap=pixaConvertToPdf"[\s\S]*?"-Wl,--wrap=pixaReadFiles"[\s\S]*?\}/,
    );
    expect(bindings).toContain('#ifdef LEPTONICA_WASM_CURATED_NO_DESKTOP_IO');
    expect(executableBindings).toMatch(
      /extern \"C\" l_ok __wrap_pixDisplay\(PIX \*, l_int32, l_int32\) \{\s*return 0;\s*\}/,
    );
    expect(executableBindings).toMatch(
      /extern \"C\" l_ok __wrap_convertFilesToPdf\(const char \*, const char \*, l_int32, l_float32,\s*l_int32, l_int32, const char \*, const char \*\) \{\s*return 1;\s*\}/,
    );
    expect(executableBindings).toMatch(
      /extern \"C\" l_ok __wrap_pixaConvertToPdf\(PIXA \*, l_int32, l_float32, l_int32, l_int32,\s*const char \*, const char \*\) \{\s*return 1;\s*\}/,
    );
    expect(executableBindings).toMatch(
      /extern \"C\" PIXA \*__wrap_pixaReadFiles\(const char \*, const char \*\) \{\s*return nullptr;\s*\}/,
    );
    expect(executableBindings).not.toMatch(/extern \"C\" l_ok pixDisplay\(/);
    expect(executableBindings).not.toMatch(/extern \"C\" l_ok convertFilesToPdf\(/);
    expect(executableBindings).not.toMatch(/extern \"C\" l_ok pixaConvertToPdf\(/);
    expect(executableBindings).not.toMatch(/extern \"C\" PIXA \*pixaReadFiles\(/);
    expect(build).not.toContain('"-Wl,--gc-sections"');
    expect(build).not.toContain('"-ffunction-sections"');
    expect(build).not.toContain('"-fdata-sections"');
    expect(build).not.toContain('"-DENABLE_PNG=OFF"');
    expect(build).not.toContain('"-DENABLE_JPEG=OFF"');
  });

  it("captures curated linker extraction evidence outside publishable artifacts", () => {
    expect(build).toContain("--link-diagnostics");
    expect(build).toContain("tmp/link-diagnostics");
    expect(build).toContain("-Wl,--why-extract=");
    expect(build).toContain("-Wl,--trace-symbol=pixRead");
    expect(build).toContain("-Wl,--trace-symbol=jpeg_read_header");
    expect(build).toContain("link diagnostics file was not produced");
    expect(ci).toContain(
      "node scripts/build.mjs --link-diagnostics tmp/link-diagnostics/default.tsv",
    );
    expect(ci).toContain("name: linker-extraction-diagnostics");
    expect(ci).toContain("path: tmp/link-diagnostics/default.tsv");
    expect(ci).toMatch(
      /name: Upload linker extraction diagnostics[\s\S]*?if: always\(\)[\s\S]*?path: tmp\/link-diagnostics\/default\.tsv/,
    );
    expect(packageContract).not.toContain("link-diagnostics");

    const publishablePath = spawnSync(
      process.execPath,
      ["scripts/build.mjs", "--link-diagnostics", "dist/linker.tsv"],
      { encoding: "utf8" },
    );
    expect(publishablePath.status).toBe(2);
    expect(publishablePath.stderr).toContain(
      "--link-diagnostics must name a file under tmp/link-diagnostics",
    );

    const escapedPath = spawnSync(
      process.execPath,
      ["scripts/build.mjs", "--link-diagnostics", "tmp/link-diagnostics/../escaped.tsv"],
      { encoding: "utf8" },
    );
    expect(escapedPath.status).toBe(2);
    expect(escapedPath.stderr).toContain(
      "--link-diagnostics must name a file under tmp/link-diagnostics",
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
    expect(browserFaultWorker).toContain('ctx.name === "fatalTrapAfterLoad"');
    expect(browserFaultWorker).toContain("testFatalEvidence");
    expect(browserFaultWorker).toContain("nativeTrapCount");
    expect(browserFaultWorker).toContain("wasmEntries++");
    expect(browserFaultWorker).toContain("wireWorker(new Leptonica(countedModule), surface)");
    expect(browserSpec).toContain("target-WASM trap");
    expect(browserSpec).toContain("nativeTrapCount: 1");
    expect(browserSpec).toContain("wasmEntries: 1");
    expect(browserFaultPage).toContain("createSession as createBrowserSession");
    expect(browserFaultPage).toContain('from "leptonica-wasm/worker"');
    expect(browserFaultPage).toContain("const session = await createBrowserSession()");
    expect(browserFaultPage).toContain("firstFatal: () => firstFatalMessage");
    expect(browserFaultPage).toContain("const productionFatal = trapped.firstFatal()");
    expect(browserFaultPage).toContain("productionEvidence: productionFatal.testFatalEvidence");
    expect(browserFaultPage).toContain('openProductionAdapterSession("fatalTrapAfterLoad")');
    expect(browserFaultPage).toContain("livePoisoned: live.isPoisoned()");
    expect(browserFaultPage).toContain("const postCallsAfterDrain = trapped.adapterPostCalls()");
    expect(browserSpec).toContain("postCallsAfterDrain");
    expect(browserFaultPage).toContain("firstFatal: () => messages.find");
    expect(browserFaultPage).toContain("const initialFatal = trapped.firstFatal()");
    expect(browserFaultPage).not.toContain("const initialFatal = messages.find");
    const initialFatalGate = browserFaultPage.indexOf("if (initialFatal?.fatal !== true");
    const terminalProbe = browserFaultPage.indexOf("const probeId = 999_999");
    expect(initialFatalGate).toBeGreaterThan(-1);
    expect(terminalProbe).toBeGreaterThan(initialFatalGate);
    expect(browserFaultPage).toContain('initialError.includes("fatal WebAssembly trap")');
    expect(browserFaultPage).toContain("const fresh = await openProductionAdapterSession()");
    expect(browserFaultPage).toContain("freshAdapterTeardownCalls");
    expect(browserFaultPage).toContain("adapterTeardownCalls");
    expect(browserFaultPage).toContain("post-fatal worker probe");
    expect(browserViteConfig).toContain('packageJson.exports["./worker"]?.default?.import');
    expect(browserViteConfig).toContain("/^leptonica-wasm\\/worker$/");
    expect(browserViteConfig).toContain('exclude: ["leptonica-wasm/worker"]');
    expect(ci).toContain("test -f dist/types/worker/index.js");
    expect(ci).toContain("test -f dist/types/worker/worker.mjs");
    // Build, browser E2E, and the independent resource sweep each fail
    // loudly if the target-WASM artifact they consume is absent.
    expect(ci.match(/test -f dist-instrumented\/leptonica\.wasm/g)).toHaveLength(3);
  });

  it("runs browser fatal-retirement and OOM evidence in independent artifact-consuming jobs", () => {
    const ciJob = workflowJob("ci");
    const buildStep = ciJob.indexOf("- name: Build instrumented target-WASM");
    const genTypesStep = ciJob.indexOf("- name: Generate runtime type and worker artifacts");
    const uploadStep = ciJob.indexOf("- name: Upload runtime build artifacts");
    const browserJob = ci.indexOf("  browser-e2e:");
    const browserStep = ci.indexOf("- name: E2E (browser output and fatal retirement)");
    const resourceJob = ci.indexOf("  instrumented-resource-failures:");
    const resourceStep = ci.indexOf("- name: Instrumented resource-failure suite");

    expect(buildStep).toBeGreaterThan(-1);
    expect(genTypesStep).toBeGreaterThan(buildStep);
    expect(uploadStep).toBeGreaterThan(genTypesStep);
    expect(browserJob).toBeGreaterThan(uploadStep);
    expect(browserStep).toBeGreaterThan(browserJob);
    expect(resourceJob).toBeGreaterThan(browserStep);
    expect(resourceStep).toBeGreaterThan(resourceJob);
    expect(workflowStep(ciJob, "Build instrumented target-WASM")).toContain(
      "node scripts/build.mjs --test-instrumentation",
    );
    const genTypesBlock = workflowStep(ciJob, "Generate runtime type and worker artifacts");
    expect(genTypesBlock).toContain("node scripts/gen-types.mjs");
    expect(genTypesBlock).toContain("test -f dist/types/worker/index.js");
    expect(genTypesBlock).toContain("test -f dist/types/worker/worker.mjs");
    const uploadBlock = workflowStep(ciJob, "Upload runtime build artifacts");
    expect(ciJob).toMatch(
      /^      runtime_builds_ready: \$\{\{ steps\.upload_runtime_builds\.outcome == 'success' \}\}$/m,
    );
    expect(uploadBlock).toContain("id: upload_runtime_builds");
    expect(uploadBlock).toContain("name: runtime-builds");
    expect(uploadBlock).toMatch(/^            dist$/m);
    expect(uploadBlock).toMatch(/^            dist-instrumented$/m);
    const artifactGuard =
      /^    if: \$\{\{ !cancelled\(\) && needs\.ci\.outputs\.runtime_builds_ready == 'true' \}\}$/m;
    const browserBlock = workflowJob("browser-e2e");
    const resourceBlock = workflowJob("instrumented-resource-failures");
    expect(browserBlock).toContain("needs: ci");
    expect(browserBlock).toMatch(artifactGuard);
    expect(browserBlock).toContain("timeout-minutes: 15");
    expect(browserBlock).toContain("name: runtime-builds");
    expect(browserBlock).toContain("Verify runtime build artifact identity");
    expect(browserBlock).toContain('report.mode !== mode || report.wasmSha256 !== actual');
    expect(browserBlock).toContain("pnpm exec playwright test");
    expect(browserBlock).not.toMatch(/if:\s*(?:false|\$\{\{\s*false\s*\}\})/);
    expect(browserBlock).not.toMatch(/continue-on-error:\s*(?:true|\$\{\{\s*true\s*\}\})/);
    expect(browserBlock).not.toContain("|| true");
    expect(resourceBlock).toContain("needs: ci");
    expect(resourceBlock).toMatch(artifactGuard);
    expect(resourceBlock).toContain("timeout-minutes: 10");
    expect(resourceBlock).toContain("name: runtime-builds");
    expect(resourceBlock).toContain("Verify runtime build artifact identity");
    expect(resourceBlock).toContain('report.mode !== mode || report.wasmSha256 !== actual');
    expect(resourceBlock).not.toMatch(/if:\s*(?:false|\$\{\{\s*false\s*\}\})/);
    expect(resourceBlock).not.toMatch(/continue-on-error:\s*(?:true|\$\{\{\s*true\s*\}\})/);
    expect(resourceBlock).not.toContain("|| true");
    expect(resourceBlock).toContain(
      "pnpm exec vitest run tests/node/fault-injection.test.ts",
    );

    const dispatchBuilder = workflowJob("dispatch-builder");
    expect(dispatchBuilder).toContain("- browser-e2e");
    expect(dispatchBuilder).toContain("- instrumented-resource-failures");
    expect(dispatchBuilder).toContain("- fixed-commit-consumer");
  });

  it("restores the Emscripten environment before the consumer package check", () => {
    const ciJob = workflowJob("ci");
    const consumerStep = workflowStep(ciJob, "Consumer fixture");
    const emsdkActivation = consumerStep.indexOf(". ./tmp/emsdk/emsdk_env.sh");
    const emccGuard = consumerStep.indexOf('emcc_path="$(command -v emcc)"');
    const pinnedEmccGuard = consumerStep.indexOf("emsdk_root");
    const consumerCheck = consumerStep.indexOf("pnpm run check");

    expect(emsdkActivation).toBeGreaterThan(-1);
    expect(emccGuard).toBeGreaterThan(emsdkActivation);
    expect(pinnedEmccGuard).toBeGreaterThan(emsdkActivation);
    expect(consumerStep).toContain('test "${emcc_path#"$emsdk_root"}" != "$emcc_path"');
    expect(consumerCheck).toBeGreaterThan(emccGuard);
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
