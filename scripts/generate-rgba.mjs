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
