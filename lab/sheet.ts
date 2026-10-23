// Renders "what you should see" sheets: the frames a test will show, in order, with captions.
// Pure Node (zlib for PNG); no image libraries.
import { writeFileSync } from "node:fs";
import { drawText, textWidth } from "../src/font.ts";
import { encodePng } from "../src/png.ts";

export const W = 240,
  H = 136;
const CAPTION_H = 22,
  PAD = 6,
  COLS = 2,
  SHEET_BG = [235, 238, 242],
  CAPTION = [30, 34, 40];

export interface Step {
  /** Short caption, max ~19 characters (uppercase letters, digits, space, ':', '-', '.'). */
  label: string;
  /** 240x136 RGBA frame. */
  rgba: Uint8Array;
}

/** A plain frame with centred text, e.g. a stand-in for the screen's own "Downloading" UI. */
export function textFrame(text: string, bg = [40, 44, 52], fg = [235, 235, 235]): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([bg[0], bg[1], bg[2], 255], i * 4);
  drawText(rgba, W, text, Math.round((W - textWidth(text, 2)) / 2), (H - 14) / 2, 2, fg);
  return rgba;
}

/** Solid colour frame with a black 64x64 square in the middle (our test pattern). */
export function squareFrame(color: number[]): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const center = Math.abs(x - W / 2) < 32 && Math.abs(y - H / 2) < 32;
      rgba.set([...(center ? [0, 0, 0] : color), 255], (y * W + x) * 4);
    }
  }
  return rgba;
}

/** Writes a PNG contact sheet of the steps (2 per row) and returns its path. */
export function writeSheet(path: string, steps: Step[]): string {
  writeFileSync(path, renderSheet(steps));
  return path;
}

/** PNG contact sheet of the steps (2 per row). */
export function renderSheet(steps: Step[]): Buffer {
  const rows = Math.ceil(steps.length / COLS);
  const cellW = W + PAD * 2,
    cellH = H + CAPTION_H + PAD * 2;
  const sw = cellW * COLS,
    sh = cellH * rows;
  const img = new Uint8Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) img.set([SHEET_BG[0], SHEET_BG[1], SHEET_BG[2], 255], i * 4);
  steps.forEach((step, k) => {
    const ox = (k % COLS) * cellW + PAD,
      oy = Math.floor(k / COLS) * cellH + PAD;
    for (let y = 0; y < H; y++) img.set(step.rgba.subarray(y * W * 4, (y + 1) * W * 4), ((oy + y) * sw + ox) * 4);
    // Caption: draw into a strip, then copy it under the frame.
    const strip = new Uint8Array(W * CAPTION_H * 4);
    for (let i = 0; i < W * CAPTION_H; i++) strip.set([SHEET_BG[0], SHEET_BG[1], SHEET_BG[2], 255], i * 4);
    drawText(strip, W, step.label, 0, 5, 2, CAPTION);
    for (let y = 0; y < CAPTION_H; y++)
      img.set(strip.subarray(y * W * 4, (y + 1) * W * 4), ((oy + H + y) * sw + ox) * 4);
  });
  return encodePng(img, sw, sh);
}
