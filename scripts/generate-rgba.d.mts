/**
 * Deterministic RGBA fixture generator (M4 golden chains).
 * @param width image width in pixels
 * @param height image height in pixels
 * @returns width*height*4 bytes, same input → same output (no RNG)
 */
export declare function generateRgba(width: number, height: number): Uint8Array

/**
 * Text-line-like horizontal bands slanted by a small angle (deskew coverage).
 * @param width image width in pixels
 * @param height image height in pixels
 * @returns width*height*4 bytes, same input → same output (no RNG)
 */
export declare function generateSlantRgba(width: number, height: number): Uint8Array

export declare function generateAreaRgba(width: number, height: number): Uint8Array
export declare function generateConnectivityRgba(width: number, height: number): Uint8Array
export declare function generateColorThresholdRgba(width: number, height: number): Uint8Array
export declare function generateColorErosionRgba(width: number, height: number): Uint8Array
export declare function generateBackgroundRgba(width: number, height: number): Uint8Array
export declare function generateSauvolaTilesRgba(width: number, height: number): Uint8Array

export declare const rgbaGenerators: Readonly<Record<string, (width: number, height: number) => Uint8Array>>
export declare function generateNamedRgba(name: string | undefined, width: number, height: number): Uint8Array
