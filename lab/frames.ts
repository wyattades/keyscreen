// Frames used by on-device experiments, shared with the dashboard pictures so they match exactly.
// Deliberately plain: big white text on black, so results are easy to describe ("I saw A, then B").
import { drawText } from "../src/font.ts";
import { bigText } from "../src/textframe.ts";

export { bigText };

const W = 240, H = 136;

/** A 4-digit number, big. */
export function numberFrame(n: number): Uint8Array {
  return bigText(String(n).padStart(4, "0"));
}

/** What erased flash looks like on screen. */
export function whiteFrame(): Uint8Array {
  return new Uint8Array(W * H * 4).fill(255);
}

/** Random white sparkles (small plus signs) on black, with an optional small label in the corner. */
export function sparkleFrame(seed = Math.random(), label = ""): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255;
  let x = Math.floor(seed * 2 ** 31) || 1;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const dot = (px: number, py: number) => {
    if (px >= 0 && px < W && py >= 0 && py < H) rgba.set([255, 255, 255, 255], (py * W + px) * 4);
  };
  for (let n = 0; n < 28; n++) {
    const cx = Math.floor(rnd() * W), cy = Math.floor(rnd() * H), r = 2 + Math.floor(rnd() * 5);
    for (let d = -r; d <= r; d++) {
      for (let t = -1; t <= 1; t++) {
        dot(cx + d, cy + t);
        dot(cx + t, cy + d);
      }
    }
  }
  if (label) drawText(rgba, W, label, 6, 6, 3, [255, 255, 255]);
  return rgba;
}
