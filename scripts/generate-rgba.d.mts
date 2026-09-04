/**
 * Deterministic RGBA fixture generator (M4 golden chains).
 * @param width image width in pixels
 * @param height image height in pixels
 * @returns width*height*4 bytes, same input → same output (no RNG)
 */
export declare function generateRgba(width: number, height: number): Uint8Array
