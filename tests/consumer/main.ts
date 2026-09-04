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
  using pix = lp.fromRGBA(new Uint8Array(4), 1, 1);
  using out = lp.chain(pix).toGray().otsu({ tile: 16 }).dilate(3, 3).run();
  const boxes: readonly Box[] = out.connComp();
  const skew: SkewResult = out.findSkew();
  const png: Uint8Array = out.toPNG();
  const hist: readonly number[] = out.histogram();
  console.log(boxes.length, skew.angle, png.length, hist.length);
}

void main();
