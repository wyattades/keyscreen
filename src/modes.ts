// Screen modes for the control dashboard. Each mode draws 240x136 frames and hands them to
// ctx.show(); the screen service streams whatever was shown last. Modes are designed around the
// ~55 KB/s USB limit: they change a small part of the screen per frame (sparse dots, 4x4 cells,
// digits), which streams smoothly, rather than redrawing everything.
import { readdirSync, readFileSync } from "node:fs";
import { addCoverage, Canvas, H, W, hsv, type RGB } from "./canvas.ts";
import { GLYPH_H, glyph } from "./font.ts";
import { onTypedChar } from "./keys.ts";
import { SandMode } from "./sand-mode.ts";
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
  /** Mode-specific state for the dashboard (in /api/status as modeState). */
  state?(): Record<string, unknown>;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------------------------

/** Draw on the page; strokes appear on the keyboard. */
export class DrawMode implements Mode {
  id = "draw";
  name = "Draw";
  blurb = "Draw right on the dashboard's picture of the screen; it shows up on the keyboard.";
  /** Called (at most once a second) with the drawing after it changes, to save it. */
  onChange: ((rgba: Uint8Array) => void) | undefined;
  /** Finished strokes. */
  private base = new Canvas();
  /**
   * The stroke in progress, as coverage per pixel. A stroke arrives in many small messages; keeping
   * one coverage map for all of it blends its soft edges once, like the page's single canvas stroke
   * (blending each piece separately stacks the edges up and makes the line look thicker).
   */
  private cov = new Float32Array(W * H);
  private stroke: unknown = undefined;
  private strokeColor: RGB = [255, 255, 255];
  private c = new Canvas();
  private dirty = true;
  private timer?: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;

  /** Restores a saved drawing. */
  load(rgba: Uint8Array) {
    this.base.rgba.set(rgba);
    this.render();
  }

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
      this.base.clear();
      this.cov.fill(0);
      this.stroke = undefined;
    } else if (msg.type === "draw") {
      const color = (msg.color as RGB) ?? [255, 255, 255];
      const r = Math.max(0, Math.min(10, Number(msg.size ?? 2)));
      // A new stroke (or an old page that doesn't say): bake the previous one in first.
      if (msg.stroke === undefined || msg.stroke !== this.stroke) {
        this.commit();
        this.stroke = msg.stroke;
        this.strokeColor = color;
      }
      // Width 2 * size + 1, like the page's ink.
      addCoverage(this.cov, (msg.segs as number[][]) ?? [], r + 0.5);
    } else return;
    this.render();
    this.scheduleSave();
  }

  private commit() {
    this.base.blendCoverage(this.cov, this.strokeColor);
    this.cov.fill(0);
  }

  private render() {
    this.c.rgba.set(this.base.rgba);
    this.c.blendCoverage(this.cov, this.strokeColor);
    this.dirty = true;
  }

  private scheduleSave() {
    if (this.saveTimer || !this.onChange) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.onChange?.(this.c.snapshot());
    }, 1000);
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
      this.stopKeys = onTypedChar(
        (ch) => this.type(ch),
        (e) => ctx.log(`keys: ${e.message}`),
      );
      this.keySource = "keyboard";
      ctx.note("Capturing every key typed on the QK108, in any app.");
    } catch (e) {
      this.stopKeys = undefined;
      this.keySource = "page";
      ctx.note(
        `Can't read the keyboard directly (${(e as Error).message}). Typing into this page works instead. To capture all keys, log out and back in, then restart the screen server.`,
      );
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
    const on: RGB = [255, 170, 40],
      off: RGB = [40, 26, 10];
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
      c.sparkle(
        Math.round(s.x),
        Math.round(s.y),
        Math.max(1, Math.round(s.r * (t < 0.4 ? 1 : 1 - t))),
        s.color,
        t < 0.4 ? 1 : 1 - t,
      );
      s.age++;
    }
    this.sparkles = this.sparkles.filter((s) => s.age < s.life);
    // An occasional lone twinkle while idle.
    if (performance.now() - this.lastKeyAt > 3000 && Math.random() < 0.05) {
      this.sparkles.push({
        x: rnd(6, W - 6),
        y: rnd(6, H - 6),
        age: 0,
        life: 5,
        color: hsv(rnd(0, 360), 0.4, 1),
        r: 3,
      });
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
      c.text(
        `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}  ${d.getHours() < 12 ? "AM" : "PM"}`,
        W / 2,
        84,
        2,
        [120, 170, 220],
        "center",
      );
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
  blurb = "Time, CPU, GPU, memory, network and temperatures for this computer, updated every second.";
  private timer?: ReturnType<typeof setInterval>;
  private prevCpu?: { idle: number; total: number };
  private prevNet?: { rx: number; tx: number; t: number };
  private gpu: Gpu | null = null;
  private gpuBusy = false;
  private hasGpu = true;
  private cpuTempPath = findCpuTemp();

  start(ctx: ModeContext) {
    const tick = () => {
      this.pollGpu();
      const cpu = this.cpu(),
        mem = this.mem(),
        net = this.net(),
        gpu = this.gpu;
      const c = new Canvas([6, 10, 14]);
      const now = new Date();
      const dim: RGB = [130, 140, 155];

      // Time and date.
      c.text(now.toLocaleTimeString("en-GB", { hour12: false }), 4, 4, 2, [255, 255, 255]);
      c.text(
        now.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" }).replace(",", ""),
        236,
        8,
        1,
        dim,
        "right",
      );

      // Bars: label, bar, percentage.
      const bar = (y: number, label: string, frac: number | null, color: RGB) => {
        c.text(label, 4, y, 2, [210, 220, 230]);
        c.rect(56, y, 124, 12, [30, 40, 50]);
        if (frac === null) {
          c.text("--", 236, y, 2, dim, "right");
          return;
        }
        const f = Math.max(0, Math.min(1, frac));
        c.rect(56, y, Math.round((124 * f) / 4) * 4, 12, color);
        c.text(`${Math.round(f * 100)}%`, 236, y, 2, [255, 255, 255], "right");
      };
      const heat = (v: number): RGB => (v > 0.85 ? [255, 90, 70] : v > 0.6 ? [255, 190, 60] : [80, 200, 120]);
      bar(24, "CPU", cpu, heat(cpu));
      bar(40, "GPU", gpu ? gpu.util : null, gpu ? heat(gpu.util) : dim);
      bar(56, "MEM", mem.used / mem.total, [90, 150, 255]);
      bar(72, "VRM", gpu ? gpu.memUsed / gpu.memTotal : null, [170, 120, 255]);

      // Network, in fixed columns so long numbers never run off the edge.
      c.text(`↓${rate(net.rx)}`, 4, 90, 2, [110, 220, 160]);
      c.text(`↑${rate(net.tx)}`, 124, 90, 2, [255, 170, 90]);

      // Details.
      const cpuTemp = this.cpuTemp();
      const temps = [cpuTemp === null ? "" : `CPU ${cpuTemp}C`, gpu ? `GPU ${gpu.temp}C ${Math.round(gpu.power)}W` : ""]
        .filter(Boolean)
        .join("   ");
      c.text(temps, 4, 107, 1, dim);
      const vram = gpu ? `   VRAM ${gb(gpu.memUsed * 2 ** 20)}/${gb(gpu.memTotal * 2 ** 20)}G` : "";
      c.text(`RAM ${gb(mem.used)}/${gb(mem.total)}G${vram}`, 4, 117, 1, dim);
      const load = readFileSync("/proc/loadavg", "utf8").split(" ")[0];
      c.text(`LOAD ${load}   UP ${uptime()}`, 4, 127, 1, dim);
      ctx.show(c.snapshot());
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }
  stop() {
    clearInterval(this.timer);
  }

  /** Asks nvidia-smi in the background (never blocks the stream); the next frame uses the answer. */
  private pollGpu() {
    if (!this.hasGpu || this.gpuBusy) return;
    this.gpuBusy = true;
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn(
        [
          "nvidia-smi",
          "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
          "--format=csv,noheader,nounits",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
    } catch {
      this.hasGpu = false;
      return;
    }
    new Response(p.stdout as ReadableStream)
      .text()
      .then((out) => {
        const [util, used, total, temp, power] = out
          .split("\n")[0]
          .split(",")
          .map((s) => parseFloat(s));
        this.gpu = Number.isFinite(total)
          ? { util: util / 100, memUsed: used, memTotal: total, temp, power: power || 0 }
          : null;
      })
      .catch(() => (this.gpu = null))
      .finally(() => (this.gpuBusy = false));
  }

  private cpu() {
    const f = readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/).slice(1).map(Number);
    const idle = f[3] + f[4],
      total = f.reduce((a, b) => a + b, 0);
    const p = this.prevCpu;
    this.prevCpu = { idle, total };
    return p && total > p.total ? 1 - (idle - p.idle) / (total - p.total) : 0;
  }
  private cpuTemp(): number | null {
    if (!this.cpuTempPath) return null;
    try {
      return Math.round(parseInt(readFileSync(this.cpuTempPath, "utf8")) / 1000);
    } catch {
      return null;
    }
  }
  /** Bytes used and total. */
  private mem() {
    const m = Object.fromEntries(
      readFileSync("/proc/meminfo", "utf8")
        .split("\n")
        .map((l) => [l.split(":")[0], parseInt(l.split(":")[1] ?? "0")]),
    );
    return { used: (m.MemTotal - m.MemAvailable) * 1024, total: m.MemTotal * 1024 };
  }
  private net() {
    let rx = 0,
      tx = 0;
    for (const line of readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name.trim() === "lo") continue;
      const f = rest.trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
    }
    const t = performance.now(),
      p = this.prevNet;
    this.prevNet = { rx, tx, t };
    return p ? { rx: ((rx - p.rx) * 1000) / (t - p.t), tx: ((tx - p.tx) * 1000) / (t - p.t) } : { rx: 0, tx: 0 };
  }
}

interface Gpu {
  util: number;
  /** MiB */
  memUsed: number;
  memTotal: number;
  temp: number;
  power: number;
}

/** Bytes per second in at most 6 characters: 999B, 12.3K, 1.2M, 115M. */
function rate(b: number): string {
  const units = ["B", "K", "M", "G"];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) {
    b /= 1000;
    i++;
  }
  return (i === 0 || b >= 100 ? Math.round(b).toString() : b.toFixed(1)) + units[i];
}

/** Bytes as GB, one decimal under 10. */
function gb(b: number): string {
  const g = b / 2 ** 30;
  return g < 10 ? g.toFixed(1) : Math.round(g).toString();
}

function uptime(): string {
  const s = parseFloat(readFileSync("/proc/uptime", "utf8"));
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}D ${h}H` : h ? `${h}H ${m}M` : `${m}M`;
}

/** The CPU package temperature sensor (Intel coretemp or AMD k10temp), if there is one. */
function findCpuTemp(): string | null {
  try {
    for (const h of readdirSync("/sys/class/hwmon")) {
      const name = readFileSync(`/sys/class/hwmon/${h}/name`, "utf8").trim();
      if (name === "coretemp" || name === "k10temp" || name === "zenpower") return `/sys/class/hwmon/${h}/temp1_input`;
    }
  } catch {}
  return null;
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
      for (let y = 0; y < this.ch; y++)
        for (let x = 0; x < this.cw; x++) {
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
    let changes = 0,
      alive = 0;
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (dx || dy) n += this.grid[((y + dy + ch) % ch) * cw + ((x + dx + cw) % cw)];
          }
        const i = y * cw + x,
          live = this.grid[i] ? n === 2 || n === 3 : n === 3;
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
        const sx = W / 2 + (s.x / s.z) * 60,
          sy = H / 2 + (s.y / s.z) * 60;
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
    if (msg.type === "text" && typeof msg.text === "string") this.setText(msg.text);
  }
  get message() {
    return this.text;
  }
  setText(text: string) {
    this.text = text.slice(0, 200);
    this.ctx?.show(renderText(this.text));
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
  return [
    new DrawMode(),
    new TickerMode(),
    new ClockMode(),
    new SysmonMode(),
    new LifeMode(),
    new StarsMode(),
    new MessageMode(),
    new ImageMode(),
    new SandMode(),
  ];
}
