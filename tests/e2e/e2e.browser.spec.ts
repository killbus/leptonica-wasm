/**
 * E2E: browser worker session vs Node worker session, byte-for-byte
 * (implement.md M6: PNG 字节 vs Node 输出逐字节比对 — environment
 * consistency; semantic correctness is anchored by the M4 oracle).
 *
 * The reference is produced through the SAME session API (worker_threads
 * adapter) with the SAME gradient and ops the browser page runs — a
 * byte diff therefore means the browser stack (worker + wasm + PNG
 * encoder) diverges from Node's, which is the only thing this test
 * claims to catch.
 */
import { expect, test } from "@playwright/test";
import { createSession } from "../../src/worker/node.ts";

function gradient(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i / 4) & 0xff;
    rgba[i + 1] = 255 - ((i / 4) & 0xff);
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
  return rgba;
}

function maskPattern(w = 9, h = 3): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const foreground = y === 0 || (y === 1 && x % 2 === 0);
      const value = foreground ? 0 : 255;
      const i = (y * w + x) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const OPS = [
  { op: "toGray" },
  { op: "otsu", tile: 16 },
  { op: "dilate", w: 3, h: 3 },
] as const;

async function nodeReference(): Promise<{ png: Uint8Array; count: number; mask: Uint8Array }> {
  const session = await createSession();
  try {
    const src = await session.load(gradient(32, 32), 32, 32);
    const out = await session.run(src, [...OPS]);
    const png = await out.toPNG();
    const count = await out.countPixels();
    const maskSrc = await session.load(maskPattern(), 9, 3);
    const maskPix = await session.run(maskSrc, [{ op: "toGray" }, { op: "threshold", level: 128 }]);
    const mask = await maskPix.toMask();
    expect(mask).toMatchObject({ width: 9, height: 3, strideBytes: 2, bitOrder: "msb-first", foregroundBit: 1 });
    expect([...mask.data]).toEqual([0xff, 0x80, 0xaa, 0x80, 0x00, 0x00]);
    return { png, count, mask: mask.data };
  } finally {
    await session.close();
  }
}

test("browser PNG matches Node output byte-for-byte", async ({ page }) => {
  const ref = await nodeReference();

  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  // The page sets window.__e2eResult (a promise) as soon as the module
  // runs; wait for its settlement from inside the page.
  const result = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __e2eResult: Promise<{
        ok: boolean;
        png?: string;
        count?: number;
        mask?: string;
        maskMeta?: { width: number; height: number; strideBytes: number; bitOrder: string; foregroundBit: number };
        error?: string;
      }>;
    };
    const r = await w.__e2eResult;
    return r;
  });

  expect(errors).toEqual([]);
  expect(result.ok, result.error).toBe(true);
  expect(result.count).toBe(ref.count);

  // Byte-for-byte: decode the base64 PNG and compare every byte.
  const browserBytes = Uint8Array.from(atob(result.png!), (c) => c.charCodeAt(0));
  expect(browserBytes.length).toBe(ref.png.length);
  const mismatch = Array.from(browserBytes.keys()).find((i) => browserBytes[i] !== ref.png[i]);
  expect(mismatch, `first differing byte at index ${mismatch}`).toBeUndefined();

  expect(result.maskMeta).toEqual({ width: 9, height: 3, strideBytes: 2, bitOrder: "msb-first", foregroundBit: 1 });
  const browserMask = Uint8Array.from(atob(result.mask!), (c) => c.charCodeAt(0));
  expect([...browserMask]).toEqual([0xff, 0x80, 0xaa, 0x80, 0x00, 0x00]);
  expect([...browserMask]).toEqual([...ref.mask]);
});

test("a real browser Worker settles every pending request after a target-WASM trap", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/fatal.html");
  const result = await page.evaluate(async () => {
    const w = globalThis as unknown as {
      __fatalE2eResult: Promise<{
        ok: boolean;
        fatal?: {
          pending: readonly { status: string; reason: string }[];
          laterError: string;
          adapterTeardownCalls: number;
          terminalGateTeardownCalls: number;
          probe: { ok: boolean; fatal: boolean };
        };
        fresh?: { width: number; height: number; depth: number };
        error?: string;
      }>;
    };
    return w.__fatalE2eResult;
  });

  expect(errors).toEqual([]);
  expect(result.ok, result.error).toBe(true);
  expect(result.fatal?.pending).toHaveLength(2);
  for (const pending of result.fatal!.pending) {
    expect(pending.status).toBe("rejected");
    expect(pending.reason).toContain("fatal WebAssembly trap");
  }
  expect(result.fatal?.laterError).toContain("WorkerSession is terminated");
  expect(result.fatal?.adapterTeardownCalls).toBe(1);
  expect(result.fatal?.terminalGateTeardownCalls).toBe(1);
  expect(result.fatal?.probe).toEqual({ ok: false, fatal: true });
  expect(result.fresh).toEqual({ width: 1, height: 1, depth: 32 });
});
