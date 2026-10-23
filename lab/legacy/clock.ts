// Clock face: big pixel-font time with a blinking colon, and the date underneath.
// Encoded as a 2-frame, 1 fps QGIF so the screen blinks the colon by itself.
import { GLYPH_H, drawText, textWidth } from "../../src/font.ts";
import { encodeQgif } from "../../src/qgif.ts";

const W = 240, H = 136;
const BG = [16, 20, 24], TIME = [232, 236, 240], DATE = [120, 165, 200];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export interface ClockOptions {
  hour12?: boolean;
}

/** RGBA clock frame for the minute containing `t`. */
export function renderClock(t: Date, colon: boolean, opts: ClockOptions = {}): Uint8Array {
  const { hour12 = true } = opts;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) rgba.set([BG[0], BG[1], BG[2], 255], i * 4);

  let hours = t.getHours();
  if (hour12) hours = hours % 12 || 12;
  const hh = hour12 ? String(hours) : String(hours).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");

  // Time: digits at 8x scale, 8 px gaps, an 8 px colon in the middle.
  const S = 8, gap = 8, colonW = 8;
  const width = textWidth(hh, S) + gap + colonW + gap + textWidth(mm, S);
  const x0 = Math.round((W - width) / 2), y0 = 20;
  drawText(rgba, W, hh, x0, y0, S, TIME);
  const cx = x0 + textWidth(hh, S) + gap;
  if (colon) {
    for (const cy of [y0 + 2 * S, y0 + 4 * S]) {
      for (let y = cy; y < cy + colonW; y++) for (let x = cx; x < cx + colonW; x++) rgba.set(TIME, (y * W + x) * 4);
    }
  }
  drawText(rgba, W, mm, cx + colonW + gap, y0, S, TIME);

  // Date: "THU OCT 22" (plus AM/PM in 12-hour mode) at 2x scale.
  const date = `${DAYS[t.getDay()]} ${MONTHS[t.getMonth()]} ${t.getDate()}${hour12 ? `  ${t.getHours() < 12 ? "AM" : "PM"}` : ""}`;
  const dy = y0 + GLYPH_H * S + 18;
  drawText(rgba, W, date, Math.round((W - textWidth(date, 2)) / 2), dy, 2, DATE);
  return rgba;
}

/** QGIF for the minute containing `t`: colon on, colon off, at 1 fps. */
export function clockGif(t: Date, opts: ClockOptions = {}): Uint8Array {
  return encodeQgif([{ rgba: renderClock(t, true, opts) }, { rgba: renderClock(t, false, opts) }], { width: W, height: H, fps: 1 });
}
