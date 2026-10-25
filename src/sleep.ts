// Sleep animations: what the keyboard screen plays while the computer's screen is locked. They're
// stored in the screen's flash and loop on the keyboard by themselves, so nothing is sent over USB
// while asleep. All built-ins are dim, for a dark room.
import { readFileSync } from "node:fs";
import { GifReader } from "omggif";
import { Canvas, H, W, type RGB } from "./canvas.ts";
import { decodePng, fitImage, isPng } from "./png.ts";
import { encodeQgif } from "./qgif.ts";

export interface SleepAnimation {
  id: string;
  name: string;
  blurb: string;
}

/** "off" keeps the live mode running while locked; "dark" shows the stored blank frame. */
export const SLEEP_MODES: SleepAnimation[] = [
  { id: "hourglass", name: "Hourglass", blurb: "Sand trickles down, then the glass flips over." },
  { id: "zzz", name: "Zzz", blurb: "Sleepy Zs drifting up." },
  { id: "night", name: "Night sky", blurb: "A crescent moon and twinkling stars." },
  { id: "dark", name: "Dark", blurb: "A black screen." },
  { id: "custom", name: "Your picture", blurb: "An uploaded PNG or animated GIF." },
  { id: "off", name: "Don't sleep", blurb: "Keep showing the live mode while the computer is locked." },
];
export const DEFAULT_SLEEP = "hourglass";

export interface SleepFrames {
  frames: Uint8Array[];
  fps: number;
}

/** Frames for a built-in animation ("dark" and "off" have none). */
export function builtinSleep(id: string): SleepFrames | undefined {
  if (id === "hourglass") return { frames: hourglass(), fps: 10 };
  if (id === "zzz") return { frames: zzz(), fps: 10 };
  if (id === "night") return { frames: night(), fps: 6 };
  return undefined;
}

/** Encodes frames as a QGIF for the screen. */
export function encodeSleep(s: SleepFrames): Uint8Array {
  return encodeQgif(
    s.frames.map((rgba) => ({ rgba })),
    { width: W, height: H, fps: s.fps },
  );
}

/** Max frames kept from an uploaded GIF (flash and upload time). */
const MAX_CUSTOM_FRAMES = 150;

/** Decodes an uploaded PNG or GIF (animated or not) into screen-sized frames. */
export function decodeCustom(bytes: Uint8Array): SleepFrames {
  if (isPng(bytes)) return { frames: [fitImage(decodePng(bytes))], fps: 1 };
  if (String.fromCharCode(...bytes.subarray(0, 3)) !== "GIF") throw new Error("send a PNG or GIF");
  const gif = new GifReader(bytes);
  const n = Math.min(gif.numFrames(), MAX_CUSTOM_FRAMES);
  const canvas = new Uint8Array(gif.width * gif.height * 4);
  const frames: Uint8Array[] = [];
  let delays = 0;
  for (let i = 0; i < n; i++) {
    const info = gif.frameInfo(i);
    gif.decodeAndBlitFrameRGBA(i, canvas);
    frames.push(fitImage({ width: gif.width, height: gif.height, rgba: canvas.slice() }));
    delays += info.delay || 10;
    // Disposal 2: clear this frame's area before the next one. (3, "restore previous", is rare; treated as 1.)
    if (info.disposal === 2)
      for (let y = info.y; y < info.y + info.height; y++)
        canvas.fill(0, (y * gif.width + info.x) * 4, (y * gif.width + info.x + info.width) * 4);
  }
  // GIF delays are in 1/100 s; use the average as the frame rate.
  const fps = Math.max(1, Math.min(30, Math.round(100 / (delays / n))));
  return { frames, fps };
}

export function decodeCustomFile(path: string): SleepFrames {
  return decodeCustom(new Uint8Array(readFileSync(path)));
}

// ---------------------------------------------------------------------------------------------
// Built-ins

const dim = (c: RGB, k: number): RGB => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

/** Sand runs from the top bulb to the bottom one, then the glass squashes flat and flips. */
function hourglass(): Uint8Array[] {
  const cx = W / 2,
    top = 14,
    neck = 68,
    bottom = 122,
    half = 34; // half-width of the bulbs at their widest
  const glass: RGB = [70, 90, 120],
    sand: RGB = [200, 150, 70],
    grain: RGB = [235, 190, 110];
  // Half-width of the glass at row y (0 at the neck).
  const widthAt = (y: number) =>
    y < neck ? (half * (neck - y)) / (neck - top) : (half * (y - neck)) / (bottom - neck);

  const draw = (p: number) => {
    // p: 0 = all sand on top, 1 = all at the bottom.
    const c = new Canvas([4, 5, 9]);
    // Top bulb: sand surface sinks from near the top to the neck.
    const topLevel = top + 8 + (neck - top - 8) * p;
    for (let y = Math.ceil(topLevel); y < neck; y++) {
      const w = Math.floor(widthAt(y)) - 2;
      if (w > 0) c.rect(cx - w, y, w * 2, 1, sand);
    }
    // Bottom bulb: a mound that grows from the floor.
    const fill = p * (bottom - neck - 10);
    for (let y = bottom - 1; y > neck; y--) {
      const w = Math.floor(widthAt(y)) - 2;
      const depth = bottom - 1 - y;
      // Mound: full width up to `fill`, then a cone above it.
      const cone = Math.max(0, w - (depth - fill) * 2);
      const ww = depth <= fill ? w : Math.min(w, cone);
      if (ww > 0 && fill > 0) c.rect(cx - ww, y, ww * 2, 1, sand);
    }
    // Falling stream from the neck to the mound (dotted, moving).
    if (p < 1) {
      const moundTop = bottom - 1 - fill - Math.max(0, (half - 2) / 2);
      for (let y = neck; y < moundTop; y += 2) c.rect(cx - 1, y + ((p * 400) % 2), 2, 1, grain);
    }
    // Glass outline, caps and frame.
    c.line(cx - half - 2, top, cx - 3, neck - 1, 1, glass);
    c.line(cx + half + 2, top, cx + 3, neck - 1, 1, glass);
    c.line(cx - 3, neck + 1, cx - half - 2, bottom, 1, glass);
    c.line(cx + 3, neck + 1, cx + half + 2, bottom, 1, glass);
    c.rect(cx - half - 10, top - 6, (half + 10) * 2, 4, dim(sand, 0.5));
    c.rect(cx - half - 10, bottom + 2, (half + 10) * 2, 4, dim(sand, 0.5));
    return c.snapshot();
  };

  // Squash vertically around the centre (k = 1 normal, 0 flat), optionally upside down.
  const squash = (rgba: Uint8Array, k: number, flip: boolean) => {
    const out = new Canvas([4, 5, 9]).snapshot();
    const cy = H / 2;
    if (k <= 0.02) return out;
    for (let y = 0; y < H; y++) {
      let sy = Math.round(cy + (y - cy) / k);
      if (sy < 0 || sy >= H) continue;
      if (flip) sy = H - 1 - sy;
      out.set(rgba.subarray(sy * W * 4, (sy + 1) * W * 4), y * W * 4);
    }
    return out;
  };

  const frames: Uint8Array[] = [];
  const steps = 56;
  for (let i = 0; i <= steps; i++) frames.push(draw(i / steps));
  const end = draw(1);
  for (let i = 0; i < 6; i++) frames.push(end); // rest
  // The full bottom, flipped, is the start again: squash the end flat, then open the start out.
  for (const k of [0.75, 0.45, 0.15]) frames.push(squash(end, k, false));
  for (const k of [0.15, 0.45, 0.75]) frames.push(squash(draw(0), k, false));
  for (let i = 0; i < 4; i++) frames.push(draw(0));
  return frames;
}

/** Three Zs drift up and to the right, growing and fading, one after another. */
function zzz(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const n = 36;
  for (let f = 0; f < n; f++) {
    const c = new Canvas([3, 4, 10]);
    for (let k = 0; k < 3; k++) {
      const p = (f / n + k / 3) % 1;
      const scale = 2 + Math.round(p * 4);
      const x = 70 + p * 110,
        y = 104 - p * 92;
      const fade = Math.sin(p * Math.PI);
      c.text("Z", Math.round(x), Math.round(y), scale, dim([140, 160, 255], 0.25 + 0.75 * fade), "center");
    }
    frames.push(c.snapshot());
  }
  return frames;
}

/** A crescent moon and twinkling stars (stars are fixed; each twinkles on its own phase). */
function night(): Uint8Array[] {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const stars = Array.from({ length: 46 }, () => ({
    x: Math.floor(rand() * W),
    y: Math.floor(rand() * H),
    phase: rand(),
    big: rand() < 0.15,
  })).filter((s) => Math.hypot(s.x - 60, s.y - 50) > 32);
  const frames: Uint8Array[] = [];
  const n = 24;
  for (let f = 0; f < n; f++) {
    const c = new Canvas([2, 3, 12]);
    for (const s of stars) {
      const b = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin((f / n + s.phase) * Math.PI * 2));
      const v = Math.round(200 * b);
      c.rect(s.x, s.y, s.big ? 2 : 1, s.big ? 2 : 1, [v, v, Math.min(255, v + 30)]);
    }
    c.disc(60, 50, 22, [210, 200, 150]);
    c.disc(70, 44, 20, [2, 3, 12]);
    frames.push(c.snapshot());
  }
  return frames;
}
