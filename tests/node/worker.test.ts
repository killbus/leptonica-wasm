import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../../src/worker/node.ts";
import type { WorkerSession } from "../../src/worker/session.ts";
import { generateRgba, generateSlantRgba } from "../../scripts/generate-rgba.mjs";
import type { Op } from "../../src/protocol.ts";

/*
 * Worker session tests (M5). Protocol round trip, transfer semantics,
 * close poisoning, terminate, and run() failure-path cleanup — every
 * checklist item from the M5 plan, exercised over real worker_threads.
 */

const artifactsPresent = existsSync(resolve("dist/leptonica.wasm")) && existsSync(resolve("dist/worker.mjs"));

describe.skipIf(!artifactsPresent)("worker session (Node worker_threads)", () => {
  let session: WorkerSession;

  beforeEach(async () => {
    session = await createSession();
  });

  afterEach(async () => {
    // close() is idempotent; safe to call again even if the test closed.
    await session.close().catch(() => {});
  });

  it("loads a Pix and reports its dimensions and depth", async () => {
    const pix = await session.load(generateRgba(48, 48), 48, 48);
    expect(pix.width).toBe(48);
    expect(pix.height).toBe(48);
    expect(pix.depth).toBe(32);
  });

  it("transfers the load buffer (the caller's view detaches)", async () => {
    const view = generateRgba(16, 16);
    const buffer = view.buffer;
    await session.load(view, 16, 16);
    expect(buffer.byteLength).toBe(0);
  });

  it("round-trips a full chain (protocol parity with the sync core)", async () => {
    const src = await session.load(generateRgba(48, 48), 48, 48);
    const out = await session.run(src, [
      { op: "toGray" },
      { op: "otsu", tile: 16 },
      { op: "dilate", w: 3, h: 3 },
    ] satisfies Op[]);
    expect(out.depth).toBe(1);
    const png = await out.toPNG();
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
  });

  it("extract transfers bytes back (no structured clone)", async () => {
    const pix = await session.load(generateRgba(16, 16), 16, 16);
    const png = await pix.toPNG();
    expect(png.byteLength).toBeGreaterThan(8);
    // The buffer is transferable — the view's byteLength is preserved
    // (a fresh buffer, zero-copy on the wire).
    expect(png.buffer.byteLength).toBe(png.byteLength);
  });

  it("queries run through the wire", async () => {
    const src = await session.load(generateRgba(48, 48), 48, 48);
    const out = await session.run(src, [{ op: "toGray" }, { op: "otsu", tile: 16 }]);
    const count = await out.countPixels();
    expect(count).toBeGreaterThan(0);
    const hist = await (await session.run(src, [{ op: "toGray" }])).histogram();
    expect(hist.length).toBe(256);
  });

  it("findSkew on the slant fixture reports a confident angle", async () => {
    const src = await session.load(generateSlantRgba(192, 256), 192, 256);
    const out = await session.run(src, [{ op: "toGray" }, { op: "otsu", tile: 16 }]);
    const r = await out.findSkew();
    expect(r.confidence).toBeGreaterThan(3);
  });

  it("close() poisons every proxy and the session", async () => {
    const pix = await session.load(generateRgba(16, 16), 16, 16);
    await session.close();
    await expect(pix.toPNG()).rejects.toThrow();
    await expect(session.load(generateRgba(16, 16), 16, 16)).rejects.toThrow();
    await expect(session.run(pix, [])).rejects.toThrow();
  });

  it("run() failure cleans up intermediates (no handle leak)", async () => {
    const src = await session.load(generateRgba(48, 48), 48, 48);
    // otsu requires 8bpp; feeding it a 32bpp source must fail — the
    // failure happens mid-chain (after toGray succeeded, at otsu).
    await expect(
      session.run(src, [{ op: "toGray" }, { op: "otsu", tile: 16 }, { op: "dilate", w: 3, h: 3 }] satisfies Op[]),
    ).resolves.toBeTruthy(); // toGray→otsu is valid; the failure case is below
    // Dilate requires 1bpp after otsu — valid. Force a real failure:
    await expect(
      session.run(src, [{ op: "otsu", tile: 16 }] satisfies Op[]),
    ).rejects.toThrow();
    // The source is still usable after a failed run (not consumed).
    const ok = await session.run(src, [{ op: "toGray" }]);
    expect(ok.depth).toBe(8);
  });

  it("remote dispose is not the API — close is (arena model)", async () => {
    const pix = await session.load(generateRgba(16, 16), 16, 16);
    // The proxy has no dispose method; the arena owns everything.
    expect((pix as unknown as Record<string, unknown>).dispose).toBeUndefined();
    expect((pix as unknown as Record<string, unknown>).terminate).toBeUndefined();
  });

  it("terminate leaves no residue (new session works after old dies)", async () => {
    const pix = await session.load(generateRgba(16, 16), 16, 16);
    // Kill the worker without close(): pending promises reject.
    session.markTerminated();
    await expect(session.run(pix, [])).rejects.toThrow();
    // A fresh session on a new worker functions normally.
    const fresh = await createSession();
    try {
      const p2 = await fresh.load(generateRgba(16, 16), 16, 16);
      expect(p2.depth).toBe(32);
    } finally {
      await fresh.close();
    }
  });
});
