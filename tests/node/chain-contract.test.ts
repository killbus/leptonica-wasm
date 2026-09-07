import { describe, expect, it } from "vitest";
import { ChainBuilder } from "../../src/core/chain.ts";
import type { Leptonica, Pix } from "../../src/core/types.ts";

/*
 * Source-level contract tests for the curated primitives.  These do not
 * require a built WASM artifact, so they keep the public boundary honest on
 * developer machines as well as in target-runtime CI.  Pixel semantics stay
 * anchored by the independent native oracle and dedicated fixtures.
 */
function builderAtDepth(depth: 1 | 8 | 32): ChainBuilder {
  return new ChainBuilder({} as Leptonica, { depth } as Pix);
}

describe("curated primitive contracts", () => {
  it("does not replace Leptonica's gamma domain with a product tuning range", () => {
    expect(() => builderAtDepth(8).cleanBackgroundToWhite(20, 70, 190)).not.toThrow();
  });

  it("does not impose arbitrary Sauvola whsize or factor maxima", () => {
    expect(() => builderAtDepth(8).sauvolaTiled(129, 1.5, 1, 1)).not.toThrow();
  });

  it("records the caller's explicit native float area threshold and relation", () => {
    const builder = builderAtDepth(1).selectByArea(4.5, 4, "gte");
    expect(builder.ops).toEqual([
      { op: "selectByArea", thresholdArea: 4.5, connectivity: 4, relation: "gte" },
    ]);
  });

  it("accepts native-defined color-mask edge values without a policy cap", () => {
    expect(() => builderAtDepth(32).maskOverColorPixels(0, 9)).not.toThrow();
  });

  it("rejects invalid background-normalization values at record time", () => {
    for (const gamma of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => builderAtDepth(8).cleanBackgroundToWhite(gamma, 70, 190)).toThrow(RangeError);
    }
    expect(() => builderAtDepth(8).cleanBackgroundToWhite(1, 190, 190)).toThrow(RangeError);
    expect(() => builderAtDepth(8).cleanBackgroundToWhite(1, 191, 190)).toThrow(RangeError);
    expect(() => builderAtDepth(8).cleanBackgroundToWhite(1, 70, 201)).toThrow(RangeError);
    expect(() => builderAtDepth(8).cleanBackgroundToWhite(1, -2_147_483_649, 190)).toThrow(RangeError);
  });

  it("rejects invalid tiled-Sauvola values without inventing tuning maxima", () => {
    for (const whsize of [1, 2_147_483_648, Number.NaN]) {
      expect(() => builderAtDepth(8).sauvolaTiled(whsize, 0.34, 1, 1)).toThrow(RangeError);
    }
    for (const factor of [-0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => builderAtDepth(8).sauvolaTiled(4, factor, 1, 1)).toThrow(RangeError);
    }
    for (const [nx, ny] of [[0, 1], [1, 0], [2_147_483_648, 1], [1, 2_147_483_648]] as const) {
      expect(() => builderAtDepth(8).sauvolaTiled(4, 0.34, nx, ny)).toThrow(RangeError);
    }
  });

  it("records all four native area relations and rejects invalid wire values", () => {
    for (const relation of ["lt", "gt", "lte", "gte"] as const) {
      expect(builderAtDepth(1).selectByArea(4, 4, relation).ops).toEqual([
        { op: "selectByArea", thresholdArea: 4, connectivity: 4, relation },
      ]);
    }
    expect(() => builderAtDepth(1).selectByArea(4, 4, "eq" as never)).toThrow(RangeError);
    expect(() => builderAtDepth(1).selectByArea(-1, 4, "gte")).toThrow(RangeError);
    expect(() => builderAtDepth(1).selectByArea(Number.POSITIVE_INFINITY, 4, "gte")).toThrow(RangeError);
    expect(() => builderAtDepth(1).selectByArea(Number.MAX_VALUE, 4, "gte")).toThrow(RangeError);
    expect(() => builderAtDepth(1).selectByArea(4, 6 as never, "gte")).toThrow(RangeError);
  });

  it("rejects color-mask values outside native domains", () => {
    for (const thresholdDiff of [-1, 256, 1.5, Number.NaN]) {
      expect(() => builderAtDepth(32).maskOverColorPixels(thresholdDiff, 1)).toThrow(RangeError);
    }
    expect(() => builderAtDepth(32).maskOverColorPixels(10, 2_147_483_647)).not.toThrow();
    for (const minDistance of [0, 1.5, 2_147_483_648, Number.NaN]) {
      expect(() => builderAtDepth(32).maskOverColorPixels(10, minDistance)).toThrow(RangeError);
    }
  });
});
