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
import { createSession } from "leptonica-wasm/worker";

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

const OPS = [
  { op: "toGray" },
  { op: "otsu", tile: 16 },
  { op: "dilate", w: 3, h: 3 },
] as const;

async function nodeReference(): Promise<{ png: Uint8Array; count: number }> {
  const session = await createSession();
  try {
    const src = await session.load(gradient(32, 32), 32, 32);
    const out = await session.run(src, [...OPS]);
    const png = await out.toPNG();
    const count = await out.countPixels();
    return { png, count };
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
    const w = globalThis as unknown as { __e2eResult: Promise<{ ok: boolean; png?: string; count?: number; error?: string }> };
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
});
