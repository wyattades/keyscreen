// A small falling-sand world (cellular automaton, in the spirit of sandspiel), used by the Sand
// mode and the sand sleep animation. Each cell is CELL x CELL screen pixels.
//
// Materials:
//   sand   falls, slides off slopes, sinks through water
//   water  falls, then spreads sideways
//   stone  stays put
//   plant  stays put; grows into touching water; burns
//   fire   flickers upward and dies out; spreads through plant; water puts it out
import type { RGB } from "./canvas.ts";

export const CELL = 2;
export const M = { Empty: 0, Sand: 1, Water: 2, Stone: 3, Plant: 4, Fire: 5 } as const;
export type M = (typeof M)[keyof typeof M];
export const MATERIALS = [
  { id: M.Sand, name: "Sand" },
  { id: M.Water, name: "Water" },
  { id: M.Stone, name: "Stone" },
  { id: M.Plant, name: "Plant" },
  { id: M.Fire, name: "Fire" },
] as const;

/** A typical colour per material (for a swatch). */
export const SWATCH: Record<number, RGB> = {
  [M.Sand]: [230, 180, 90],
  [M.Water]: [40, 125, 230],
  [M.Stone]: [125, 125, 135],
  [M.Plant]: [40, 185, 60],
  [M.Fire]: [255, 150, 20],
};

export class SandWorld {
  readonly w: number;
  readonly h: number;
  /** Material per cell. */
  readonly cell: Uint8Array;
  /** Per-cell variation (0-255): shade for sand/stone/plant, remaining life for fire. */
  readonly extra: Uint8Array;
  /** Set on every cell that moved this step, so it isn't moved twice. */
  private moved: Uint8Array;
  private tick = 0;
  /** Hue offset for "rainbow" sand (see sandColor); 0 = plain sand colours. */
  hue = -1;

  constructor(widthPx: number, heightPx: number) {
    this.w = Math.floor(widthPx / CELL);
    this.h = Math.floor(heightPx / CELL);
    this.cell = new Uint8Array(this.w * this.h);
    this.extra = new Uint8Array(this.w * this.h);
    this.moved = new Uint8Array(this.w * this.h);
  }

  get(x: number, y: number) {
    return x < 0 || x >= this.w || y < 0 || y >= this.h ? M.Stone : this.cell[y * this.w + x];
  }

  /** Puts `m` at (x, y) if the cell is empty (or always, with `force`). */
  put(x: number, y: number, m: M, force = false) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    const i = y * this.w + x;
    if (!force && this.cell[i] !== M.Empty) return;
    this.cell[i] = m;
    this.extra[i] = m === M.Fire ? 20 + ((Math.random() * 25) | 0) : (Math.random() * 256) | 0;
  }

  /** Sprinkles `m` into a disc of radius r (cells) around (cx, cy), filling about `density` of it. */
  pour(cx: number, cy: number, r: number, m: M, density = 0.5) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= r * r && Math.random() < density) this.put(cx + dx, cy + dy, m, m === M.Empty);
  }

  /** Clears a disc of radius r (cells). */
  blast(cx: number, cy: number, r: number) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) this.put(cx + dx, cy + dy, M.Empty, true);
  }

  /** The topmost filled cell in column x, or h if the column is empty. */
  surface(x: number) {
    for (let y = 0; y < this.h; y++) if (this.cell[y * this.w + x] !== M.Empty) return y;
    return this.h;
  }

  count(m?: M) {
    let n = 0;
    for (const c of this.cell) if (m === undefined ? c !== M.Empty : c === m) n++;
    return n;
  }

  /** One simulation step. With `openFloor`, whatever falls off the bottom row is gone. */
  step(openFloor = false) {
    const { w, h, cell, extra, moved } = this;
    moved.fill(0);
    this.tick++;
    const swap = (a: number, b: number) => {
      const c = cell[a],
        e = extra[a];
      cell[a] = cell[b];
      extra[a] = extra[b];
      cell[b] = c;
      extra[b] = e;
      moved[b] = 1;
      moved[a] = cell[a] === M.Empty ? 0 : 1;
    };
    // Bottom-up so falling things move once; alternate the row direction so nothing drifts sideways.
    for (let y = h - 1; y >= 0; y--) {
      const ltr = (y + this.tick) % 2 === 0;
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        const m = cell[i];
        if (m === M.Empty || m === M.Stone || moved[i]) continue;
        const below = y + 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        if (m === M.Sand || m === M.Water) {
          if (below >= h) {
            if (openFloor) cell[i] = M.Empty;
            continue;
          }
          // Sand sinks through water; water only falls into empty cells.
          const can = (cx: number, cy: number) => {
            const t = this.get(cx, cy);
            return t === M.Empty || (m === M.Sand && t === M.Water);
          };
          if (can(x, below)) swap(i, below * w + x);
          else if (can(x + side, below)) swap(i, below * w + x + side);
          else if (can(x - side, below)) swap(i, below * w + x - side);
          else if (m === M.Water) {
            // Spread: up to 3 cells sideways.
            for (let d = 1; d <= 3; d++) {
              if (this.get(x + side * d, y) !== M.Empty) break;
              if (d === 3 || this.get(x + side * (d + 1), y) !== M.Empty) {
                swap(i, y * w + x + side * d);
                break;
              }
            }
          }
        } else if (m === M.Plant) {
          // Grow into a touching water cell now and then.
          if (Math.random() < 0.03) {
            const nx = x + ((Math.random() * 3) | 0) - 1,
              ny = y + ((Math.random() * 3) | 0) - 1;
            if (this.get(nx, ny) === M.Water) this.put(nx, ny, M.Plant, true);
          }
        } else if (m === M.Fire) {
          if (--extra[i] === 0) {
            cell[i] = M.Empty;
            continue;
          }
          // Spread to plant, die in water.
          for (const [dx, dy] of [
            [0, 1],
            [0, -1],
            [1, 0],
            [-1, 0],
          ] as const) {
            const t = this.get(x + dx, y + dy);
            if (t === M.Plant && Math.random() < 0.25) this.put(x + dx, y + dy, M.Fire, true);
            if (t === M.Water) {
              cell[i] = M.Empty;
              if (Math.random() < 0.3) this.put(x + dx, y + dy, M.Empty, true); // steam
              break;
            }
          }
          if (cell[i] !== M.Fire) continue;
          // Flicker upward.
          const nx = x + ((Math.random() * 3) | 0) - 1;
          if (y > 0 && this.get(nx, y - 1) === M.Empty && Math.random() < 0.6) swap(i, (y - 1) * w + nx);
        }
      }
    }
  }

  /** Colour of a cell (undefined = empty). */
  color(i: number): RGB | undefined {
    const m = this.cell[i],
      e = this.extra[i];
    const v = e / 255;
    switch (m) {
      case M.Sand:
        return this.hue >= 0
          ? hueColor((this.hue + e * 0.7) % 360)
          : ([215 + 30 * v, 165 + 30 * v, 80 + 25 * v].map(Math.round) as RGB);
      case M.Water:
        return [40, 110 + 30 * v, 230].map(Math.round) as RGB;
      case M.Stone:
        return [110 + 30 * v, 110 + 30 * v, 120 + 30 * v].map(Math.round) as RGB;
      case M.Plant:
        return [40, 160 + 50 * v, 60].map(Math.round) as RGB;
      case M.Fire: {
        const k = Math.min(1, e / 30);
        return [255, Math.round(80 + 150 * k), Math.round(30 * k)];
      }
    }
    return undefined;
  }

  /** Draws the world into an RGBA buffer of `widthPx` (cells already sized to fit), over `bg`. */
  render(rgba: Uint8Array, widthPx: number, bg: RGB, brightness = 1) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const c = this.color(y * this.w + x) ?? bg;
        const r = Math.round(c[0] * brightness),
          g = Math.round(c[1] * brightness),
          b = Math.round(c[2] * brightness);
        for (let py = 0; py < CELL; py++)
          for (let px = 0; px < CELL; px++) {
            const o = ((y * CELL + py) * widthPx + x * CELL + px) * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 255;
          }
      }
  }
}

function hueColor(h: number): RGB {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}
