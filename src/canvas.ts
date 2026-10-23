// Tiny RGBA drawing toolkit for 240x136 screen frames.
// Tip: things aligned to the 4x4 grid (x, y, w, h multiples of 4) cost the least to stream,
// because the screen's format updates whole 4x4 tiles.
import { GLYPH_H, drawText, textWidth } from "./font.ts";

export const W = 240, H = 136;
export type RGB = [number, number, number];

export class Canvas {
  readonly rgba: Uint8Array;

  constructor(fill: RGB = [0, 0, 0]) {
    this.rgba = new Uint8Array(W * H * 4);
    this.clear(fill);
  }

  clear(c: RGB = [0, 0, 0]) {
    for (let i = 0; i < W * H; i++) this.rgba.set([c[0], c[1], c[2], 255], i * 4);
  }

  /** Copy of the pixels, safe to hand to the screen while drawing continues. */
  snapshot(): Uint8Array {
    return this.rgba.slice();
  }

  px(x: number, y: number, c: RGB) {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && x < W && y >= 0 && y < H) {
      const o = (y * W + x) * 4;
      this.rgba[o] = c[0];
      this.rgba[o + 1] = c[1];
      this.rgba[o + 2] = c[2];
    }
  }

  rect(x: number, y: number, w: number, h: number, c: RGB) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const o = (yy * W + xx) * 4;
      this.rgba[o] = c[0];
      this.rgba[o + 1] = c[1];
      this.rgba[o + 2] = c[2];
    }
  }

  disc(cx: number, cy: number, r: number, c: RGB) {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r) this.px(cx + x, cy + y, c);
  }

  line(x0: number, y0: number, x1: number, y1: number, r: number, c: RGB) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) this.disc(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, r, c);
  }

  /** Pixel-font text. `align` positions it around x. Returns its width. */
  text(s: string, x: number, y: number, scale: number, c: RGB, align: "left" | "center" | "right" = "left") {
    const w = textWidth(s, scale);
    const left = align === "center" ? Math.round(x - w / 2) : align === "right" ? x - w : x;
    drawText(this.rgba, W, s, left, y, scale, c);
    return w;
  }

  /** A 4-point sparkle of radius r, brightness 0..1. */
  sparkle(cx: number, cy: number, r: number, c: RGB, brightness = 1) {
    const k = (v: number) => Math.round(v * brightness);
    const col: RGB = [k(c[0]), k(c[1]), k(c[2])];
    for (let d = -r; d <= r; d++) {
      this.px(cx + d, cy, col);
      this.px(cx, cy + d, col);
    }
    const s = Math.max(1, Math.floor(r / 2));
    for (let d = -s; d <= s; d++) {
      this.px(cx + d, cy + d, col);
      this.px(cx + d, cy - d, col);
    }
  }
}

export const textHeight = (scale: number) => GLYPH_H * scale;

/** HSV (h 0..360, s/v 0..1) to RGB. */
export function hsv(h: number, s = 1, v = 1): RGB {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)];
}
