// Screen modes for the control dashboard. Each mode draws 240x136 frames and hands them to
// ctx.show(); the screen service streams whatever was shown last. Modes are designed around the
// ~55 KB/s USB limit: they change a small part of the screen per frame (sparse dots, 4x4 cells,
// digits), which streams smoothly, rather than redrawing everything.
import { readFileSync } from "node:fs";
import { Canvas, H, W, hsv, type RGB } from "./canvas.ts";
import { GLYPH_H, glyph } from "./font.ts";
import { onTypedChar } from "./keys.ts";
import { renderText } from "./textframe.ts";

export interface ModeContext {
  show: (rgba: Uint8Array) => void;
  log: (m: string) => void;
  /** Lets a mode tell the page something (e.g. where key presses come from). */
  note: (m: string) => void;
}

export interface Mode {
  id: string;
  name: string;
  blurb: string;
  start(ctx: ModeContext): void;
  stop(): void;
  /** Messages from the page (JSON already parsed). */
  input?(msg: Record<string, unknown>): void;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------------------------

/** Draw on the page; strokes appear on the keyboard. */
export class DrawMode implements Mode {
  id = "draw";
  name = "Draw";
  blurb = "Draw on the canvas; it shows up on the keyboard.";
  private c = new Canvas();
  private dirty = true;
  private timer?: ReturnType<typeof setInterval>;

  start(ctx: ModeContext) {
    this.dirty = true;
    this.timer = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      ctx.show(this.c.snapshot());
    }, 50);
  }
  stop() {
    clearInterval(this.timer);
  }
  input(msg: Record<string, unknown>) {
    if (msg.type === "clear") {
      this.c.clear();
      this.dirty = true;
    } else if (msg.type === "draw") {
      const color = (msg.color as RGB) ?? [255, 255, 255];
      const r = Math.max(0, Math.min(10, Number(msg.size ?? 2)));
      for (const [x0, y0, x1, y1] of (msg.segs as number[][]) ?? []) this.c.line(x0, y0, x1, y1, r, color);
      this.dirty = true;
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** The last letters typed, scrolling right to left like an LED letter board, with sparkles. */
export class TickerMode implements Mode {
  id = "ticker";
  name = "Key ticker";
  blurb = "The last letters you typed scroll by like an LED sign, with sparkles on every key press.";
  private text = "";
  private end = 0; // text column shown at the board's right edge; slides toward the newest letter
  private sparkles: { x: number; y: number; age: number; life: number; color: RGB; r: number }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private stopKeys?: () => void;
  private ctx?: ModeContext;
  private lastKeyAt = 0;
  /** Where key presses come from: read straight from the keyboard, or forwarded by the page. */
  keySource: "keyboard" | "page" = "page";
  static readonly DOT = 6; // one font pixel = 6x6 screen pixels (a 4x4 lit dot + gap)
  static readonly COLS = W / TickerMode.DOT; // 30 font columns visible
  static readonly TOP = Math.round((H - GLYPH_H * TickerMode.DOT) / 2);

  start(ctx: ModeContext) {
    this.ctx = ctx;
    try {
      this.stopKeys = onTypedChar((ch) => this.type(ch), (e) => ctx.log(`keys: ${e.message}`));
      this.keySource = "keyboard";
      ctx.note("Capturing every key typed on the QK108, in any app.");
    } catch (e) {
      this.stopKeys = undefined;
      this.keySource = "page";
      ctx.note(`Can't read the keyboard directly (${(e as Error).message}). Typing into this page works instead. To capture all keys, log out and back in, then restart the screen server.`);
    }
    this.timer = setInterval(() => this.frame(), 100);
  }
  stop() {
    clearInterval(this.timer);
    this.stopKeys?.();
  }
  input(msg: Record<string, unknown>) {
    if (msg.type === "key" && typeof msg.key === "string") this.type(msg.key);
  }

  private type(ch: string) {
    if (ch === "\b") this.text = this.text.slice(0, -1);
    else this.text = (this.text + (ch === "\n" ? "   " : ch)).slice(-60);
    this.lastKeyAt = performance.now();
    // A burst of sparkles, mostly near the newest letter (right side).
    for (let i = 0; i < 5; i++) {
      const nearNew = Math.random() < 0.7;
      this.sparkles.push({
        x: nearNew ? rnd(W - 70, W - 6) : rnd(6, W - 6),
        y: rnd(6, H - 6),
        age: 0,
        life: 4 + Math.floor(rnd(0, 4)),
        color: hsv(rnd(0, 360), 0.6, 1),
        r: 2 + Math.floor(rnd(0, 4)),
      });
    }
  }

  /** Text as font columns (7-bit masks, top row = bit 6), with a 1-column gap after each letter. */
  private columns(): number[] {
    const cols: number[] = [];
    for (const ch of this.text) {
      const rows = glyph(ch);
      for (let c = 0; c < 5; c++) {
        let mask = 0;
        for (let r = 0; r < GLYPH_H; r++) if (rows[r] & (0x10 >> c)) mask |= 1 << (GLYPH_H - 1 - r);
        cols.push(mask);
      }
      cols.push(0);
    }
    return cols;
  }

  private frame() {
    const { DOT, COLS, TOP } = TickerMode;
    const cols = this.columns();
    // Slide the right edge toward the end of the text, so new letters glide in from the right.
    const goal = cols.length;
    if (this.end < goal) this.end += Math.max(1, Math.ceil((goal - this.end) / 3));
    if (this.end > goal) this.end = goal;
    const c = new Canvas([8, 6, 4]);
    const on: RGB = [255, 170, 40], off: RGB = [40, 26, 10];
    for (let col = 0; col < COLS; col++) {
      const src = this.end - COLS + 1 + col;
      const mask = src >= 0 && src < cols.length ? cols[src] : 0;
      for (let r = 0; r < GLYPH_H; r++) {
        const lit = mask & (1 << (GLYPH_H - 1 - r));
        c.rect(col * DOT + 1, TOP + r * DOT + 1, DOT - 2, DOT - 2, lit ? on : off);
      }
    }
    // Sparkles: grow, then fade.
    for (const s of this.sparkles) {
      const t = s.age / s.life;
      c.sparkle(Math.round(s.x), Math.round(s.y), Math.max(1, Math.round(s.r * (t < 0.4 ? 1 : 1 - t))), s.color, t < 0.4 ? 1 : 1 - t);
      s.age++;
    }
    this.sparkles = this.sparkles.filter((s) => s.age < s.life);
    // An occasional lone twinkle while idle.
    if (performance.now() - this.lastKeyAt > 3000 && Math.random() < 0.05) {
      this.sparkles.push({ x: rnd(6, W - 6), y: rnd(6, H - 6), age: 0, life: 5, color: hsv(rnd(0, 360), 0.4, 1), r: 3 });
    }
    this.ctx?.show(c.snapshot());
  }
}

// ---------------------------------------------------------------------------------------------

/** Big clock with live seconds. */
export class ClockMode implements Mode {
  id = "clock";
  name = "Clock";
  blurb = "Time with live seconds, and the date.";
  private timer?: ReturnType<typeof setInterval>;
  private shown = "";

  start(ctx: ModeContext) {
    this.shown = "";
    const tick = () => {
      const d = new Date();
      const h = d.getHours() % 12 || 12;
      const time = `${h}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
      if (time === this.shown) return;
      this.shown = time;
      const c = new Canvas([10, 12, 18]);
      c.text(time, W / 2, 34, 4, [240, 240, 245], "center");
      const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
      c.text(`${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}  ${d.getHours() < 12 ? "AM" : "PM"}`, W / 2, 84, 2, [120, 170, 220], "center");
      // Seconds progress bar along the bottom, on the 4px grid.
      c.rect(16, 116, Math.round(((W - 32) * d.getSeconds()) / 59 / 4) * 4, 4, [80, 140, 255]);
      ctx.show(c.snapshot());
    };
    tick();
    this.timer = setInterval(tick, 100);
  }
  stop() {
    clearInterval(this.timer);
  }
}

// ---------------------------------------------------------------------------------------------

/** CPU, memory and network, with a scrolling CPU graph. */
export class SysmonMode implements Mode {
  id = "sysmon";
  name = "System monitor";
  blurb = "CPU, memory and network for this computer, updated every second.";
  private timer?: ReturnType<typeof setInterval>;
  private prevCpu?: { idle: number; total: number };
  private prevNet?: { rx: number; tx: number; t: number };
  private history: number[] = [];

  start(ctx: ModeContext) {
    const tick = () => {
      const cpu = this.cpu(), mem = this.mem(), net = this.net();
      this.history = [...this.history, cpu].slice(-57);
      const c = new Canvas([6, 10, 14]);
      const bar = (y: number, label: string, frac: number, color: RGB) => {
        c.text(label, 8, y, 2, [210, 220, 230]);
        c.rect(116, y, 116, 12, [30, 40, 50]);
        c.rect(116, y, Math.round((116 * Math.min(1, frac)) / 4) * 4, 12, color);
      };
      bar(8, `CPU ${String(Math.round(cpu * 100)).padStart(3)}%`, cpu, cpu > 0.8 ? [255, 90, 70] : [80, 200, 120]);
      bar(28, `MEM ${String(Math.round(mem * 100)).padStart(3)}%`, mem, [90, 150, 255]);
      const fmt = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)}M` : `${Math.round(b / 1e3)}K`);
      c.text(`NET DOWN ${fmt(net.rx)} UP ${fmt(net.tx)}`, 8, 50, 2, [200, 190, 120]);
      // CPU history graph (each sample a 4px-wide column).
      const gy = 72, gh = 56;
      c.rect(4, gy, 232, gh, [14, 20, 28]);
      this.history.forEach((v, i) => {
        const h = Math.max(4, Math.round((gh * v) / 4) * 4);
        c.rect(4 + (i + 57 - this.history.length) * 4, gy + gh - h, 4, h, hsv(120 - 120 * v, 0.8, 0.9));
      });
      ctx.show(c.snapshot());
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }
  stop() {
    clearInterval(this.timer);
  }

  private cpu() {
    const f = readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/).slice(1).map(Number);
    const idle = f[3] + f[4], total = f.reduce((a, b) => a + b, 0);
    const p = this.prevCpu;
    this.prevCpu = { idle, total };
    return p && total > p.total ? 1 - (idle - p.idle) / (total - p.total) : 0;
  }
  private mem() {
    const m = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").map((l) => [l.split(":")[0], parseInt(l.split(":")[1] ?? "0")]));
    return 1 - m.MemAvailable / m.MemTotal;
  }
  private net() {
    let rx = 0, tx = 0;
    for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name.trim() === "lo") continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    const t = performance.now(), p = this.prevNet;
    this.prevNet = { rx, tx, t };
    return p ? { rx: ((rx - p.rx) * 1000) / (t - p.t), tx: ((tx - p.tx) * 1000) / (t - p.t) } : { rx: 0, tx: 0 };
  }
}

// ---------------------------------------------------------------------------------------------

/** Conway's Game of Life; each cell is one 4x4 tile (the cheapest thing to animate here). */
export class LifeMode implements Mode {
  id = "life";
  name = "Game of Life";
  blurb = "Conway's Game of Life, one cell per 4x4 tile. Reseeds itself when it settles.";
  private cw = W / 4;
  private ch = H / 4;
  private grid = new Uint8Array(this.cw * this.ch);
  private age = new Uint16Array(this.cw * this.ch);
  private timer?: ReturnType<typeof setInterval>;
  private still = 0;
  private hue = 0;

  start(ctx: ModeContext) {
    this.seed();
    this.timer = setInterval(() => {
      this.step();
      const c = new Canvas([4, 6, 10]);
      for (let y = 0; y < this.ch; y++) for (let x = 0; x < this.cw; x++) {
        const i = y * this.cw + x;
        if (this.grid[i]) c.rect(x * 4, y * 4, 3, 3, hsv((this.hue + Math.min(this.age[i], 60) * 4) % 360, 0.8, 1));
      }
      ctx.show(c.snapshot());
    }, 200);
  }
  stop() {
    clearInterval(this.timer);
  }
  input(msg: Record<string, unknown>) {
    if (msg.type === "reseed") this.seed();
  }

  private seed() {
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = Math.random() < 0.25 ? 1 : 0;
    this.age.fill(0);
    this.still = 0;
    this.hue = rnd(0, 360);
  }
  private step() {
    const { cw, ch } = this;
    const next = new Uint8Array(this.grid.length);
    let changes = 0, alive = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx || dy) n += this.grid[((y + dy + ch) % ch) * cw + ((x + dx + cw) % cw)];
      }
      const i = y * cw + x, live = this.grid[i] ? n === 2 || n === 3 : n === 3;
      next[i] = live ? 1 : 0;
      this.age[i] = live ? this.age[i] + 1 : 0;
      if (next[i] !== this.grid[i]) changes++;
      alive += next[i];
    }
    this.grid = next;
    this.still = changes < 12 ? this.still + 1 : 0;
    if (this.still > 25 || alive < 20) this.seed();
  }
}

// ---------------------------------------------------------------------------------------------

/** Flying through a starfield. */
export class StarsMode implements Mode {
  id = "stars";
  name = "Starfield";
  blurb = "Stars rushing toward you. Sparse dots, so it streams smoothly.";
  private stars: { x: number; y: number; z: number }[] = [];
  private timer?: ReturnType<typeof setInterval>;

  start(ctx: ModeContext) {
    this.stars = Array.from({ length: 70 }, () => this.newStar(rnd(0.1, 1)));
    this.timer = setInterval(() => {
      const c = new Canvas();
      for (const s of this.stars) {
        s.z -= 0.025;
        if (s.z <= 0.05) Object.assign(s, this.newStar(1));
        const sx = W / 2 + (s.x / s.z) * 60, sy = H / 2 + (s.y / s.z) * 60;
        if (sx < 0 || sx >= W || sy < 0 || sy >= H) {
          Object.assign(s, this.newStar(1));
          continue;
        }
        const b = Math.round(255 * Math.min(1, 1.2 - s.z));
        const size = s.z < 0.3 ? 2 : 1;
        c.rect(sx, sy, size, size, [b, b, Math.min(255, b + 30)]);
      }
      ctx.show(c.snapshot());
    }, 100);
  }
  stop() {
    clearInterval(this.timer);
  }
  private newStar(z: number) {
    return { x: rnd(-2, 2), y: rnd(-1.2, 1.2), z };
  }
}

// ---------------------------------------------------------------------------------------------

/** Show a typed message, auto-sized. */
export class MessageMode implements Mode {
  id = "message";
  name = "Message";
  blurb = "Type a message on the page; it shows big on the keyboard.";
  private text = "HELLO!";
  private ctx?: ModeContext;

  start(ctx: ModeContext) {
    this.ctx = ctx;
    ctx.show(renderText(this.text));
  }
  stop() {}
  input(msg: Record<string, unknown>) {
    if (msg.type === "text" && typeof msg.text === "string") {
      this.text = msg.text.slice(0, 200);
      this.ctx?.show(renderText(this.text));
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** Show an uploaded picture (the server decodes it and calls show()). */
export class ImageMode implements Mode {
  id = "image";
  name = "Image";
  blurb = "Upload a picture; it's scaled to fit the screen.";
  last?: Uint8Array;
  private ctx?: ModeContext;

  start(ctx: ModeContext) {
    this.ctx = ctx;
    ctx.show(this.last ?? renderText("UPLOAD AN IMAGE"));
  }
  stop() {}
  setImage(rgba: Uint8Array) {
    this.last = rgba;
    this.ctx?.show(rgba);
  }
}

export function allModes(): Mode[] {
  return [new DrawMode(), new TickerMode(), new ClockMode(), new SysmonMode(), new LifeMode(), new StarsMode(), new MessageMode(), new ImageMode()];
}
