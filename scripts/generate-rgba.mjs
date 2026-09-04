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
