/*
 * Deterministic RGBA fixture generator (M4 golden chains).
 *
 * Both the native oracle and the wasm test replay the same chain on bytes
 * produced by this function — no binary fixture in git, no RNG, so the
 * same (width, height) always yields the same image on every machine.
 *
 * The pattern is chosen to exercise the operators:
 * - a horizontal luminance gradient (ramp on R) → toGray/threshold/otsu
 * - a vertical gradient on G → anisotropic structures
 * - a B channel XOR texture → high-frequency content for sobel/morph
 * - a dark diagonal band → strong skew signal for deskew/findSkew
 *
 * generateSlantRgba (M4 review B3): the diagonal band above sits at ~45°,
 * far outside pixFindSkew's ±7° sweep window — every deskew golden chain
 * was a passthrough test (conf 0 < MinAllowedConfidence 3.0 → pixClone
 * shortcut, byte-identical output). The slant fixture puts text-line-like
 * horizontal bands at a small angle so findSkew reports a confident angle
 * and deskew's real rotation path executes (verified: conf 3.486, output
 * changes, residual −0.22° after deskew).
 */
/**
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function generateRgba(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`generateRgba: bad dimensions ${width}x${height}`);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const onDiagonal = Math.abs(x - y) < 4;
      rgba[i] = onDiagonal ? 30 : Math.min(255, Math.round((x / width) * 255));
      rgba[i + 1] = Math.min(255, Math.round((y / height) * 255));
      rgba[i + 2] = onDiagonal ? 30 : (x ^ y) & 0xff;
      rgba[i + 3] = 0xff;
    }
  }
  return rgba;
}

/**
 * Text-line-like horizontal bands slanted by a small angle — the shape
 * pixFindSkew is designed for. Deterministic like generateRgba.
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function generateSlantRgba(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`generateSlantRgba: bad dimensions ${width}x${height}`);
  }
  const rgba = new Uint8Array(width * height * 4);
  const slant = -0.04; // rad — inside the ±7° (≈±0.122 rad) sweep window
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const yl = y - Math.tan(slant) * x;
      const onBand = ((yl % 20) + 20) % 20 < 8;
      rgba[i] = onBand ? 0 : 255;
      rgba[i + 1] = onBand ? 0 : 255;
      rgba[i + 2] = onBand ? 0 : 255;
      rgba[i + 3] = 0xff;
    }
  }
  return rgba;
}

function solidRgba(width, height, value = 255) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`solidRgba: bad dimensions ${width}x${height}`);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = value;
    rgba[i + 1] = value;
    rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
  return rgba;
}

function setRgb(rgba, width, x, y, r, g, b) {
  const i = (y * width + x) * 4;
  rgba[i] = r;
  rgba[i + 1] = g;
  rgba[i + 2] = b;
}

/** Components with exactly 3 and 4 foreground pixels. */
export function generateAreaRgba(width, height) {
  if (width < 12 || height < 5) throw new Error(`generateAreaRgba: need at least 12x5, got ${width}x${height}`);
  const rgba = solidRgba(width, height);
  for (const [x, y] of [[1, 1], [2, 1], [3, 1], [8, 1], [9, 1], [8, 2], [9, 2]]) {
    setRgb(rgba, width, x, y, 0, 0, 0);
  }
  return rgba;
}

/** Two foreground pixels touching only diagonally. */
export function generateConnectivityRgba(width, height) {
  if (width < 4 || height < 4) throw new Error(`generateConnectivityRgba: need at least 4x4, got ${width}x${height}`);
  const rgba = solidRgba(width, height);
  setRgb(rgba, width, 1, 1, 0, 0, 0);
  setRgb(rgba, width, 2, 2, 0, 0, 0);
  return rgba;
}

/** RGB spreads at threshold - 1, threshold, and threshold + 1. */
export function generateColorThresholdRgba(width, height) {
  if (width < 3 || height < 1) throw new Error(`generateColorThresholdRgba: need at least 3x1, got ${width}x${height}`);
  const rgba = solidRgba(width, height, 100);
  setRgb(rgba, width, 0, 0, 100, 100, 109);
  setRgb(rgba, width, 1, 0, 100, 100, 110);
  setRgb(rgba, width, 2, 0, 100, 100, 111);
  return rgba;
}

/** A centered 5x5 color region; minDistance=2 must erode it to 3x3. */
export function generateColorErosionRgba(width, height) {
  if (width < 9 || height < 9) throw new Error(`generateColorErosionRgba: need at least 9x9, got ${width}x${height}`);
  const rgba = solidRgba(width, height, 100);
  const x0 = Math.floor((width - 5) / 2);
  const y0 = Math.floor((height - 5) / 2);
  for (let y = y0; y < y0 + 5; y++) {
    for (let x = x0; x < x0 + 5; x++) {
      setRgb(rgba, width, x, y, 100, 100, 140);
    }
  }
  return rgba;
}

/** Uneven paper-like background with dark strokes for normalization. */
export function generateBackgroundRgba(width, height) {
  const rgba = solidRgba(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const background = 150 + Math.round(70 * x / Math.max(1, width - 1));
      const stroke = y % 16 >= 5 && y % 16 <= 7 && x > 6 && x < width - 6;
      setRgb(rgba, width, x, y, stroke ? 35 : background, stroke ? 35 : background, stroke ? 35 : background);
    }
  }
  return rgba;
}

/** Four illumination zones with local dark strokes to force tiled Sauvola. */
export function generateSauvolaTilesRgba(width, height) {
  const rgba = solidRgba(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const zone = (x < width / 2 ? 0 : 1) + (y < height / 2 ? 0 : 2);
      const background = [210, 170, 230, 190][zone];
      const localY = y % Math.max(8, Math.floor(height / 4));
      const stroke = localY >= 3 && localY <= 5 && x % Math.max(16, Math.floor(width / 4)) > 3;
      const value = stroke ? Math.max(0, background - 100) : background;
      setRgb(rgba, width, x, y, value, value, value);
    }
  }
  return rgba;
}

export const rgbaGenerators = Object.freeze({
  default: generateRgba,
  slant: generateSlantRgba,
  area: generateAreaRgba,
  connectivity: generateConnectivityRgba,
  colorThreshold: generateColorThresholdRgba,
  colorErosion: generateColorErosionRgba,
  background: generateBackgroundRgba,
  sauvolaTiles: generateSauvolaTilesRgba,
});

export function generateNamedRgba(name, width, height) {
  const generator = rgbaGenerators[name ?? "default"];
  if (!generator) throw new Error(`unknown RGBA fixture '${name}'`);
  return generator(width, height);
}
