// One-shot actions straight on the keyboard, for when the screen server isn't running.
import { ensureLayout, type Layout } from "./layout.ts";
import { encodeQgif } from "./qgif.ts";
import { Screen } from "./qk108.ts";

/** Connects, makes sure the flash layout exists, runs `fn`, and disconnects. */
export async function withScreen<T>(log: (m: string) => void, fn: (s: Screen, layout: Layout) => Promise<T>): Promise<T> {
  const s = await Screen.connect(15000, log);
  try {
    const layout = await ensureLayout(s, log);
    return await fn(s, layout);
  } finally {
    s.close();
  }
}

/**
 * Shows a still picture (RGBA 240x136) that stays on screen after this process exits:
 * parks on the blank frame, erases block 0 (no "Downloading"), writes the picture there, and shows it.
 */
export async function showStill(s: Screen, layout: Layout, rgba: Uint8Array) {
  const gif = encodeQgif([{ rgba }], { width: 240, height: 136, fps: 1 });
  await s.switchTable([layout.frames.BLANK], layout.total, "flip");
  await s.funcErase(1, [layout.frames.BLANK], layout.total);
  s.writeWindow = 4;
  await s.writeImage(0, gif);
  await s.switchTable([{ start: 0, length: gif.length }], layout.total, "flip");
}
