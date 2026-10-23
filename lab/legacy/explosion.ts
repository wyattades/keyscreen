// Explosion animation for the typing meter: white flash, the full bar bursting into
// particles with gravity, and an expanding shockwave. Ends on several frames of the
// empty meter, so there's time to switch away before the GIF loops.

export interface Bar {
  width: number;
  height: number;
  /** Renders the meter at a level (RGBA). */
  render: (level: number) => Uint8Array;
  levels: number;
  /** Segment rectangles [x, y, w, h] and colors, for spawning particles. */
  segments: { x: number; y: number; w: number; h: number; color: [number, number, number] }[];
  background: [number, number, number];
}

export const EXPLOSION_FPS = 20;
const BURST_FRAMES = 26; // 1.3 s of explosion
const TAIL_FRAMES = 10; // 0.5 s of empty meter before it would loop

/** How long to stay on the explosion before switching back (ms): burst plus part of the tail. */
export const EXPLOSION_SHOW_MS = Math.round(((BURST_FRAMES + 3) * 1000) / EXPLOSION_FPS);

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

export function explosionFrames(bar: Bar): Uint8Array[] {
  const { width: W, height: H, background: bg } = bar;
  const rand = rng(108);
  const cx = W / 2, cy = bar.segments[0].y + bar.segments[0].h / 2;
  const full = bar.render(bar.levels), empty = bar.render(0);

  // ~14 particles per segment, flung away from the bar centre.
  const particles = bar.segments.flatMap((s) =>
    Array.from({ length: 14 }, () => {
      const x = s.x + rand() * s.w, y = s.y + rand() * s.h;
      const ang = Math.atan2(y - cy, x - cx) + (rand() - 0.5) * 1.2;
      const speed = 3 + rand() * 7;
      return { x, y, vx: Math.cos(ang) * speed * 1.4, vy: Math.sin(ang) * speed - 3 - rand() * 3, color: s.color, size: rand() < 0.3 ? 8 : 4 };
    }),
  );

  const frames: Uint8Array[] = [];
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

  for (let f = 0; f < BURST_FRAMES; f++) {
    let rgba: Uint8Array;
    if (f < 2) {
      // Flash: the full bar on a bright background.
      rgba = full.slice();
      const flash = f === 0 ? [255, 255, 255] : [255, 200, 120];
      for (let i = 0; i < W * H; i++) {
        const o = i * 4;
        if (rgba[o] === bg[0] && rgba[o + 1] === bg[1] && rgba[o + 2] === bg[2]) rgba.set(flash, o);
      }
      frames.push(rgba);
      continue;
    }
    const t = (f - 2) / (BURST_FRAMES - 2); // 0..1 over the burst
    rgba = empty.slice();
    // Briefly tint the background warm, fading out.
    const warm = mix([90, 40, 10], bg, Math.min(1, t * 3));
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (rgba[o] === bg[0] && rgba[o + 1] === bg[1] && rgba[o + 2] === bg[2]) rgba.set(warm, o);
    }
    // Shockwave ring.
    const r = 10 + t * 190, ringColor = mix([255, 240, 200], warm, t);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.hypot(x - cx, (y - cy) * 1.4);
        if (Math.abs(d - r) < 3) rgba.set(ringColor, (y * W + x) * 4);
      }
    }
    // Particles: move, fall, fade toward the background. Drawn snapped to the 4px grid.
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.6;
      p.vx *= 0.97;
      const c = mix(p.color, warm, Math.max(0, t * 1.2 - 0.15));
      const px = Math.round(p.x / 4) * 4, py = Math.round(p.y / 4) * 4;
      for (let y = py; y < py + p.size; y++) {
        for (let x = px; x < px + p.size; x++) {
          if (x >= 0 && x < W && y >= 0 && y < H) rgba.set(c, (y * W + x) * 4);
        }
      }
    }
    frames.push(rgba);
  }
  for (let f = 0; f < TAIL_FRAMES; f++) frames.push(empty);
  return frames;
}
