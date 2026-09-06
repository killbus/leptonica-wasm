/**
 * Consumer fixture (M0 review F16): compile the package's public types
 * with skipLibCheck FALSE — the strictest consumer posture. Any d.ts or
 * .ts-source type error the package ships surfaces here, in a project
 * that consumes it the way a real user would.
 */
import { load } from "leptonica-wasm";
import type { Box, SkewResult } from "leptonica-wasm";

async function main(): Promise<void> {
  const lp = await load();
  // A 16x16 gradient: real pixels, not a degenerate 1x1, so the chain
  // reaches queries the type surface must answer (M4 review B2: this
  // fixture now RUNS, not just compiles).
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i / 4) & 0xff;
    rgba[i + 1] = 255 - ((i / 4) & 0xff);
    rgba[i + 2] = 128;
    rgba[i + 3] = 255;
  }
  using pix = lp.fromRGBA(rgba, 16, 16);
  using out = lp.chain(pix).toGray().threshold(128).dilate(3, 3).run();
  const boxes: readonly Box[] = out.connComp();
  const png: Uint8Array = out.toPNG();
  console.log("consumer ok:", boxes.length, png.length);
}

void main();
