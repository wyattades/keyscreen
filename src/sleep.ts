// Sleep animations: what the keyboard screen plays while the computer's screen is locked. They're
// stored in the screen's flash and loop on the keyboard by themselves, so nothing is sent over USB
// while asleep. All built-ins are dim, for a dark room.
import { readFileSync } from "node:fs";
import { GifReader } from "omggif";
import { Canvas, H, W, type RGB } from "./canvas.ts";
import { decodePng, fitImage, isPng } from "./png.ts";
import { encodeQgif } from "./qgif.ts";
import { M, SandWorld } from "./sand.ts";

export interface SleepAnimation {
  id: string;
  name: string;
  blurb: string;
}

/** "off" keeps the live mode running while locked; "dark" shows the stored blank frame. */
export const SLEEP_MODES: SleepAnimation[] = [
  { id: "sand", name: "Falling sand", blurb: "Sand pours down until half the screen is full, then drains away." },
  { id: "zzz", name: "Zzz", blurb: "Sleepy Zs drifting up." },
  { id: "night", name: "Night sky", blurb: "A crescent moon and twinkling stars." },
  { id: "dark", name: "Dark", blurb: "A black screen." },
  { id: "custom", name: "Your picture", blurb: "An uploaded PNG or animated GIF." },
  { id: "off", name: "Don't sleep", blurb: "Keep showing the live mode while the computer is locked." },
];
export const DEFAULT_SLEEP = "sand";

export interface SleepFrames {
  frames: Uint8Array[];
  fps: number;
}

/** Frames for a built-in animation ("dark" and "off" have none). */
export function builtinSleep(id: string): SleepFrames | undefined {
  if (id === "sand") return { frames: fallingSand(), fps: 10 };
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

/**
 * Three streams wander along the top and pour sand until the bottom half is full; then the floor
 * opens and it all drains out, so the loop ends empty, the way it started. Seeded, so it's the
 * same animation every time.
 */
function fallingSand(): Uint8Array[] {
  const world = new SandWorld(W, H);
  const realRandom = Math.random;
  let seed = 11;
  Math.random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  try {
    const frames: Uint8Array[] = [];
    const half = (world.w * world.h) / 2;
    const frame = () => {
      const rgba = new Uint8Array(W * H * 4);
      world.render(rgba, W, [4, 5, 9], 0.75);
      frames.push(rgba);
    };
    // Pour from four slowly wandering streams; three steps per frame so grains fall fast.
    for (let f = 0; world.count() < half && f < 300; f++) {
      for (let k = 0; k < 4; k++) {
        const x = Math.round(world.w * (0.5 + 0.4 * Math.sin(f / (40 + k * 13) + k * 1.7)));
        world.pour(x, 2, 2, M.Sand, 0.55);
      }
      for (let s = 0; s < 3; s++) world.step();
      frame();
    }
    // Let it settle, rest, then drain through the floor.
    for (let f = 0; f < 10; f++) {
      for (let s = 0; s < 3; s++) world.step();
      frame();
    }
    for (let f = 0; f < 10; f++) frames.push(frames[frames.length - 1]);
    for (let f = 0; world.count() > 0 && f < 200; f++) {
      for (let s = 0; s < 3; s++) world.step(true);
      frame();
    }
    for (let f = 0; f < 5; f++) frame();
    return frames;
  } finally {
    Math.random = realRandom;
  }
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
