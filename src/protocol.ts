/**
 * Operator protocol — the serializable op descriptions shared by the sync
 * core, the Worker client, and the native oracle harness (design §5.1).
 *
 * The chain builder records Ops on the main thread; run() sends the whole
 * array as one message; the sync core replays it. The native harness parses
 * the same JSON shape so oracle comparisons exercise one description.
 */

/** Rotation quality (design §4.2 rotate). */
export type RotateQuality = "area" | "shear";

/** Edge filter orientation (design §4.2 sobel). */
export type SobelOrientation = "all" | "h" | "v";

/** Shear direction (design §4.2 shear). */
export type ShearDirection = "h" | "v";

/** Luminance weights for toGray — order: red, green, blue. */
export type GrayWeights = readonly [number, number, number];

/** Grayscale conversion weights preset. */
export interface ToGrayOp {
  readonly op: "toGray";
  /** Custom weights [r, g, b]; omit for leptonica's perceptual default. */
  readonly weights?: GrayWeights;
}

export interface ThresholdOp {
  readonly op: "threshold";
  /** Threshold level 0..255; src < level → 1 (leptonica semantics). */
  readonly level: number;
}

export interface OtsuOp {
  readonly op: "otsu";
  /** Tile size in px (sx = sy = tile; leptonica requires >= 16; default 16). */
  readonly tile?: number;
  /** Smooth factor (default 0.1). */
  readonly factor?: number;
}

export interface SauvolaOp {
  readonly op: "sauvola";
  /** Window half-size in px (whsize). */
  readonly whsize: number;
  /** Factor for threshold variance (default 0.34). */
  readonly factor?: number;
}

export interface DeskewOp {
  readonly op: "deskew";
  /** Search reduction ∈ {1, 2, 4} (0 → default 2; smaller = finer). */
  readonly reduction?: number;
}

export interface RotateOp {
  readonly op: "rotate";
  /** Angle in radians, clockwise. */
  readonly angle: number;
  /** Rotation strategy; default "area". */
  readonly quality?: RotateQuality;
}

export interface ScaleOp {
  readonly op: "scale";
  readonly fx: number;
  /** Defaults to fx when omitted (uniform). */
  readonly fy?: number;
}

export interface ShearOp {
  readonly op: "shear";
  readonly direction: ShearDirection;
  /** Angle in radians. */
  readonly angle: number;
}

export interface ClipOp {
  readonly op: "clip";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TranslateOp {
  readonly op: "translate";
  readonly dx: number;
  readonly dy: number;
}

export type MorphOpKind = "dilate" | "erode" | "open" | "close";

export interface MorphOp {
  readonly op: MorphOpKind;
  /** Full brick sel size in px (w × h; e.g. 3,3 = 3x3 sel). */
  readonly w: number;
  readonly h: number;
}

export type BitwiseKind = "or" | "and" | "xor";

export interface BitwiseOp {
  readonly op: BitwiseKind;
  /** Handle id of the second operand (1bpp both sides). */
  readonly other: number;
}

export interface BlendOp {
  readonly op: "blend";
  readonly other: number;
  /** Blend fraction 0..1. */
  readonly frac: number;
}

export interface AddBorderOp {
  readonly op: "addBorder";
  /** Border thickness in px on every side. */
  readonly t: number;
  /** Border pixel value; default 0 (black). */
  readonly val?: number;
}

export interface SobelOp {
  readonly op: "sobel";
  /** Edge orientation; default "all". */
  readonly orientation?: SobelOrientation;
}

/** A single link in a chain — applied in order. */
export type Op =
  | ToGrayOp
  | ThresholdOp
  | OtsuOp
  | SauvolaOp
  | DeskewOp
  | RotateOp
  | ScaleOp
  | ShearOp
  | ClipOp
  | TranslateOp
  | MorphOp
  | BitwiseOp
  | BlendOp
  | AddBorderOp
  | SobelOp;

/** Depth requirements per op (design §4.2 类型规则 — enforced at chain build). */
export type Depth = 1 | 2 | 4 | 8 | 16 | 24 | 32;

export interface DepthRule {
  readonly requires: readonly Depth[] | null; // null = any depth
  readonly produces?: Depth | ((input: Depth) => Depth);
}

export const OP_DEPTH_RULES: Readonly<Record<Op["op"], DepthRule>> = {
  toGray: { requires: [32, 24, 16, 8, 4, 2], produces: 8 },
  threshold: { requires: [8], produces: 1 },
  otsu: { requires: [8], produces: 1 },
  sauvola: { requires: [8], produces: 1 },
  deskew: { requires: [1], produces: 1 },
  rotate: { requires: null },
  scale: { requires: null },
  shear: { requires: null },
  clip: { requires: null },
  translate: { requires: null },
  dilate: { requires: [1], produces: 1 },
  erode: { requires: [1], produces: 1 },
  open: { requires: [1], produces: 1 },
  close: { requires: [1], produces: 1 },
  or: { requires: [1], produces: 1 },
  and: { requires: [1], produces: 1 },
  xor: { requires: [1], produces: 1 },
  blend: { requires: [32] },
  addBorder: { requires: null },
  sobel: { requires: [8], produces: 8 },
};

/** Query descriptions (no Pix produced — direct values back). */
export type Query =
  | { readonly query: "findSkew" }
  | { readonly query: "connComp" }
  | { readonly query: "countPixels" }
  | { readonly query: "histogram" }
  | { readonly query: "average" };
