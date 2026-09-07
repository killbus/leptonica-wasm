import { describe, expect, it } from "vitest";
import type { CuratedModule, PixHandle } from "../../src/core/emscripten-glue-shape.d.ts";
import { Leptonica } from "../../src/core/types.ts";
import { toTransferableArrayBuffer } from "../../src/worker/bytes.ts";
import { RemotePix, WorkerSession } from "../../src/worker/session.ts";
import type { WorkerRequest, WorkerResponse } from "../../src/worker/protocol.ts";

function fakePixHandle(): PixHandle {
  return { delete() {}, deleteLater() { return this; }, isDeleted() { return false; } };
}

describe("JS-owned extraction bytes", () => {
  it("returns the exact arrays produced by the curated module", () => {
    const png = new Uint8Array([1, 2]);
    const jpeg = new Uint8Array([3, 4]);
    const rgba = new Uint8Array([5, 6, 7, 8]);
    const mask = new Uint8Array([0x80]);
    const module = {
      destroyPix() {},
      pixWidth: () => 1,
      pixHeight: () => 1,
      pixDepth: () => 1,
      toPNG: () => png,
      toJPEG: () => jpeg,
      toRGBA: () => rgba,
      toMask: () => mask,
    } as unknown as CuratedModule;
    const lp = new Leptonica(module);
    const pix = lp.adopt(fakePixHandle());

    expect(pix.toPNG()).toBe(png);
    expect(pix.toJPEG(85)).toBe(jpeg);
    expect(pix.toRGBA()).toBe(rgba);
    expect(pix.toMask().data).toBe(mask);
    lp.close();
  });
});

describe("transferable byte views", () => {
  it("reuses an ordinary full-view ArrayBuffer", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(toTransferableArrayBuffer(bytes)).toBe(bytes.buffer);
  });

  it("copies only the addressed bytes of partial and DataView inputs", () => {
    const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
    const partial = backing.subarray(1, 5);
    const partialBuffer = toTransferableArrayBuffer(partial);
    const dataViewBuffer = toTransferableArrayBuffer(new DataView(backing.buffer, 2, 3));

    expect(partialBuffer).not.toBe(backing.buffer);
    expect([...new Uint8Array(partialBuffer)]).toEqual([1, 2, 3, 4]);
    expect([...new Uint8Array(dataViewBuffer)]).toEqual([2, 3, 4]);
  });

  it.runIf(typeof SharedArrayBuffer !== "undefined")("copies SharedArrayBuffer-backed views", () => {
    const shared = new SharedArrayBuffer(4);
    const bytes = new Uint8Array(shared);
    bytes.set([1, 2, 3, 4]);
    const buffer = toTransferableArrayBuffer(bytes);

    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4]);
  });
});

function fakeSession() {
  let receive: ((response: WorkerResponse) => void) | undefined;
  const posted: Array<{ message: WorkerRequest; transfer: Transferable[] }> = [];
  const session = new WorkerSession(
    (message, transfer = []) => {
      posted.push({ message, transfer });
      if (message.type === "load") {
        queueMicrotask(() => receive?.({
          id: message.id, ok: true, type: "load", handle: 1,
          width: message.w, height: message.h, depth: 32,
        }));
      }
    },
    (callback) => { receive = callback; },
  );
  return { session, posted };
}

describe("WorkerSession.load exact-view semantics", () => {
  it("keeps worker handles opaque and rejects direct RemotePix construction", async () => {
    const { session } = fakeSession();
    const pix = await session.load(new Uint8Array([1, 2, 3, 4]), 1, 1);
    const RemotePixCtor = RemotePix as unknown as new (...args: unknown[]) => RemotePix;

    expect("id" in pix).toBe(false);
    expect(() => new RemotePixCtor(session, 99, 1, 1, 32)).toThrow(
      /cannot be constructed directly/,
    );

    session.terminate();
  });

  it("transfers a full ordinary buffer by identity", async () => {
    const { session, posted } = fakeSession();
    const rgba = new Uint8Array([1, 2, 3, 4]);
    await session.load(rgba, 1, 1);
    const request = posted[0]?.message;

    expect(request?.type).toBe("load");
    if (request?.type !== "load") throw new Error("expected load request");
    expect(request.buffer).toBe(rgba.buffer);
    expect(posted[0]?.transfer).toEqual([rgba.buffer]);
  });

  it("copies a partial view without leaking unrelated backing bytes", async () => {
    const { session, posted } = fakeSession();
    const backing = new Uint8Array([9, 1, 2, 3, 4, 9]);
    await session.load(backing.subarray(1, 5), 1, 1);
    const request = posted[0]?.message;

    expect(request?.type).toBe("load");
    if (request?.type !== "load") throw new Error("expected load request");
    expect(request.buffer).not.toBe(backing.buffer);
    expect([...new Uint8Array(request.buffer)]).toEqual([1, 2, 3, 4]);
    expect(posted[0]?.transfer).toEqual([request.buffer]);
  });

  it("validates the view length rather than its backing allocation", () => {
    const { session } = fakeSession();
    const backing = new Uint8Array(8);
    expect(() => session.load(backing.subarray(0, 3), 1, 1)).toThrow(
      "load: expected 4 bytes, got 3",
    );
  });
});

describe("WorkerSession transport failure cleanup", () => {
  it("forgets a request when postMessage throws synchronously", async () => {
    let receive: ((response: WorkerResponse) => void) | undefined;
    const session = new WorkerSession(
      () => { throw new Error("post failed"); },
      (callback) => { receive = callback; },
    );

    await expect(session.init()).rejects.toThrow("post failed");

    const staleResponse = {
      id: 1,
      get ok(): boolean { throw new Error("stale response was inspected"); },
    } as unknown as WorkerResponse;
    expect(() => receive?.(staleResponse)).not.toThrow();
  });
});

describe("WorkerSession arena ownership", () => {
  it("rejects foreign RemotePix extraction and queries before posting", async () => {
    const first = fakeSession();
    const second = fakeSession();
    const pix = await first.session.load(new Uint8Array([1, 2, 3, 4]), 1, 1);

    const extract = second.session.extract(pix, "png");
    const query = second.session.query(pix, { query: "average" });
    await expect(extract).rejects.toThrow("belongs to a different session");
    await expect(query).rejects.toThrow("belongs to a different session");
    expect(second.posted).toHaveLength(0);

    first.session.terminate();
    second.session.terminate();
  });
});
