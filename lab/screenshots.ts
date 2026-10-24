// Screenshots of every mode, as one labeled grid for the README (docs/modes.png).
// Runs the screen server against the simulated screen (no keyboard needed) and shows each
// frame the way the keyboard does, after its tile compression.
//
//   bun lab/screenshots.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas, H, W, hsv, type RGB } from "../src/canvas.ts";
import { drawText, textWidth } from "../src/font.ts";
import { decodePng, encodePng } from "../src/png.ts";
import { decodeQgif, encodeQgif } from "../src/qgif.ts";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "docs", "modes.png");
const PORT = 4119;
const BASE = `http://localhost:${PORT}`;

const server = Bun.spawn(["bun", "src/cli.ts", "serve", "--fake", "--port", String(PORT)], {
  cwd: ROOT,
  stdout: "ignore",
  stderr: "inherit",
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (path: string, body: unknown) =>
  fetch(BASE + path, {
    method: "POST",
    body: (body instanceof Uint8Array || typeof body === "string" ? body : JSON.stringify(body)) as BodyInit,
  }).then((r) => {
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
  });

async function frame(): Promise<Uint8Array> {
  const png = new Uint8Array(await (await fetch(`${BASE}/frame.png`)).arrayBuffer());
  const rgba = decodePng(png).rgba;
  return decodeQgif(encodeQgif([{ rgba }], { width: W, height: H, fps: 1 })).frames[0];
}

/** A smiley and a rainbow wave, drawn as strokes like the Draw page sends them. */
async function drawSomething() {
  await post("/api/input", { type: "clear" });
  const ring = (cx: number, cy: number, r: number, from = 0, to = Math.PI * 2) => {
    const segs: number[][] = [];
    for (let i = 0; i < 24; i++) {
      const a = from + ((to - from) * i) / 24,
        b = from + ((to - from) * (i + 1)) / 24;
      segs.push(
        [cx + r * Math.cos(a), cy + r * Math.sin(a), cx + r * Math.cos(b), cy + r * Math.sin(b)].map(Math.round),
      );
    }
    return segs;
  };
  await post("/api/input", { type: "draw", segs: ring(70, 68, 46), color: [255, 210, 60], size: 3 });
  await post("/api/input", {
    type: "draw",
    segs: [
      [55, 52, 55, 60],
      [85, 52, 85, 60],
    ],
    color: [255, 210, 60],
    size: 3,
  });
  await post("/api/input", {
    type: "draw",
    segs: ring(70, 70, 24, 0.5, Math.PI - 0.5),
    color: [255, 210, 60],
    size: 3,
  });
  for (let i = 0; i < 6; i++) {
    const segs: number[][] = [];
    for (let x = 140; x < 232; x += 6)
      segs.push([
        x,
        40 + i * 12 + Math.round(8 * Math.sin(x / 12)),
        x + 6,
        40 + i * 12 + Math.round(8 * Math.sin((x + 6) / 12)),
      ]);
    const [r, g, b] = hsv(i * 55, 0.85, 1);
    await post("/api/input", { type: "draw", segs, color: [r, g, b], size: 2 });
  }
}

/** A small sunset picture for Image mode. */
function sunset(): Uint8Array {
  const c = new Canvas();
  for (let y = 0; y < 88; y++) {
    const t = y / 88;
    c.rect(0, y, W, 1, [Math.round(40 + 215 * t), Math.round(30 + 110 * t), Math.round(110 - 40 * t)]);
  }
  c.disc(120, 88, 30, [255, 220, 120]);
  for (let y = 88; y < H; y++) {
    const t = (y - 88) / (H - 88);
    c.rect(0, y, W, 1, [Math.round(30 + 20 * t), Math.round(40 + 30 * t), Math.round(90 + 30 * t)]);
  }
  for (let i = 0; i < 6; i++) c.rect(120 - 26 + i * 4, 96 + i * 7, 52 - i * 8, 2, [255, 200, 110]);
  return c.snapshot();
}

const shots: { label: string; setup: () => Promise<void>; wait: number }[] = [
  { label: "Draw", setup: drawSomething, wait: 600 },
  {
    label: "Key ticker",
    setup: async () => {
      // 5 letters fill the sign. Let the scroll settle, then the last key adds fresh sparkles.
      for (const k of "QK10") await post("/api/input", { type: "key", key: k });
      await sleep(1500);
      await post("/api/input", { type: "key", key: "8" });
    },
    wait: 600,
  },
  { label: "Clock", setup: async () => {}, wait: 1200 },
  { label: "System monitor", setup: async () => {}, wait: 2500 },
  { label: "Game of Life", setup: async () => {}, wait: 3000 },
  { label: "Stars", setup: async () => {}, wait: 2000 },
  { label: "Message", setup: () => post("/text", "Lunch at 1?"), wait: 600 },
  { label: "Image", setup: () => post("/image", sunset()), wait: 600 },
];
const ids = ["draw", "ticker", "clock", "sysmon", "life", "stars", "message", "image"];

try {
  for (let i = 0; i < 40; i++) {
    if (
      await fetch(`${BASE}/api/status`).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    await sleep(250);
  }
  const frames: Uint8Array[] = [];
  for (const [i, shot] of shots.entries()) {
    await post("/api/mode", { id: ids[i] });
    await sleep(300);
    await shot.setup();
    await sleep(shot.wait);
    frames.push(await frame());
    console.log(`captured ${shot.label}`);
  }

  // Grid: 4 columns, each screen at 2x with its label underneath.
  const S = 2,
    COLS = 4,
    PAD = 24,
    LABEL = 3,
    labelH = 7 * LABEL + 16;
  const cw = W * S,
    ch = H * S + labelH;
  const rows = Math.ceil(frames.length / COLS);
  const GW = COLS * cw + (COLS + 1) * PAD,
    GH = rows * ch + (rows + 1) * PAD - 8;
  const out = new Uint8Array(GW * GH * 4);
  const bg: RGB = [24, 26, 31];
  for (let i = 0; i < GW * GH; i++) out.set([...bg, 255], i * 4);
  frames.forEach((f, n) => {
    const ox = PAD + (n % COLS) * (cw + PAD),
      oy = PAD + Math.floor(n / COLS) * (ch + PAD);
    for (let y = 0; y < H * S; y++)
      for (let x = 0; x < W * S; x++) {
        const si = (Math.floor(y / S) * W + Math.floor(x / S)) * 4;
        out.set([f[si], f[si + 1], f[si + 2], 255], ((oy + y) * GW + ox + x) * 4);
      }
    const label = shots[n].label;
    const lx = ox + Math.round((cw - textWidth(label, LABEL)) / 2);
    drawText(out, GW, label, lx, oy + H * S + 12, LABEL, [225, 228, 235]);
  });
  mkdirSync(join(ROOT, "docs"), { recursive: true });
  writeFileSync(OUT, encodePng(out, GW, GH));
  console.log(`wrote ${OUT} (${GW}x${GH})`);
} finally {
  await post("/api/shutdown", {}).catch(() => server.kill());
  await server.exited;
}
