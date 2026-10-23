// Renders text onto a 240x136 frame: word-wrapped, at the largest pixel-font size that fits.
// The font is uppercase letters, digits and a little punctuation (see font.ts).
import { GLYPH_H, drawText, textWidth } from "./font.ts";

const W = 240, H = 136, MARGIN = 8;

export interface TextOptions {
  color?: number[];
  background?: number[];
  /** Largest pixel scale to try (1 font pixel = scale screen pixels). */
  maxScale?: number;
}

function wrap(text: string, scale: number): string[] | undefined {
  const maxW = W - MARGIN * 2;
  const lines: string[] = [];
  for (const para of text.toUpperCase().split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (textWidth(word, scale) > maxW) return undefined; // a single word doesn't fit at this size
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, scale) <= maxW) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function renderText(text: string, opts: TextOptions = {}): Uint8Array {
  const { color = [255, 255, 255], background = [0, 0, 0], maxScale = 10 } = opts;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([background[0], background[1], background[2], 255], i * 4);
  for (let scale = maxScale; scale >= 1; scale--) {
    const lines = wrap(text, scale);
    if (!lines) continue;
    const lineH = GLYPH_H * scale + Math.max(2, scale * 2);
    const total = lines.length * lineH - Math.max(2, scale * 2);
    if (total > H - MARGIN * 2 && scale > 1) continue;
    let y = Math.round((H - total) / 2);
    for (const line of lines) {
      drawText(rgba, W, line, Math.round((W - textWidth(line, scale)) / 2), y, scale, color);
      y += lineH;
    }
    return rgba;
  }
  return rgba;
}

/** Big white text centred on black. Picks the largest scale that fits. */
export function bigText(text: string): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255;
  let scale = 14;
  while (scale > 2 && (textWidth(text, scale) > W - 16 || GLYPH_H * scale > H - 16)) scale--;
  drawText(rgba, W, text, Math.round((W - textWidth(text, scale)) / 2), Math.round((H - GLYPH_H * scale) / 2), scale, [255, 255, 255]);
  return rgba;
}

