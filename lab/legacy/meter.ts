// Typing meter + clock. When you're not typing the screen shows a clock; typing fills a
// segmented bar, and when it's full it explodes. Every look is a pre-rendered QGIF:
//   - meter levels 1..12 and the explosion are uploaded once, together with a pool of
//     erased spare blocks;
//   - each minute, the next clock face is written into one spare block (~0.9 s, no erase);
//   - the screen is switched between them with flip-mode table writes (~140 ms).
// When the pool runs out, everything is re-uploaded with a fresh pool.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sleep } from "../../src/hidraw.ts";
import { Screen, type SlotEntry } from "../../src/qk108.ts";
import { encodeQgif } from "../../src/qgif.ts";
import { EXPLOSION_FPS, EXPLOSION_SHOW_MS, explosionFrames, type Bar } from "./explosion.ts";
import { clockGif, type ClockOptions } from "./clock.ts";

const W = 240, H = 136;
export const LEVELS = 12;
/** Key presses needed to light one segment. */
const KEYS_PER_SEGMENT = 2;
/** Spare blocks erased per upload: one clock face per minute, so 60 = re-upload about once an hour. */
const POOL_BLOCKS = 60;
/** Write the next minute's clock face this many seconds before the minute turns. */
const CLOCK_LEAD_S = 6;
const MANIFEST = "lab/legacy/state/meter.json";

const BG: [number, number, number] = [16, 20, 24];
const TRACK: [number, number, number] = [44, 50, 58];
const SEG = 16, FILL = 12, X0 = (W - LEVELS * SEG + (SEG - FILL)) / 2, Y0 = 48, Y1 = 88;

/** Segment colour: green -> yellow -> red across the bar. */
function segmentColor(i: number): [number, number, number] {
  const t = i / (LEVELS - 1);
  return t < 0.5 ? [Math.round(510 * t), 220, 60] : [255, Math.round(220 * (2 - 2 * t)), 60];
}

/** RGBA frame for one meter level (0 = empty). */
export function renderLevel(level: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let c = BG;
      if (y >= Y0 && y < Y1 && x >= X0) {
        const i = Math.floor((x - X0) / SEG);
        if (i < LEVELS && (x - X0) % SEG < FILL) c = i < level ? segmentColor(i) : TRACK;
      }
      rgba.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
  }
  return rgba;
}

export const BAR: Bar = {
  width: W,
  height: H,
  levels: LEVELS,
  render: renderLevel,
  background: BG,
  segments: Array.from({ length: LEVELS }, (_, i) => ({ x: X0 + i * SEG, y: Y0, w: FILL, h: Y1 - Y0, color: segmentColor(i) })),
};

/** QGIF payloads: levels 0..LEVELS (one frame each), then the explosion animation. */
export function meterFrames(): Uint8Array[] {
  const levels = Array.from({ length: LEVELS + 1 }, (_, l) => encodeQgif([{ rgba: renderLevel(l) }], { width: W, height: H, fps: 1 }));
  const boom = encodeQgif(explosionFrames(BAR).map((rgba) => ({ rgba })), { width: W, height: H, fps: EXPLOSION_FPS });
  return [...levels, boom];
}

/** What's on the screen, saved so restarts can reuse it. Spare blocks are used once each. */
interface Manifest {
  hash: string;
  entries: SlotEntry[];
  allocated: number;
  firstSpare: number;
  /** Next spare block to hand out. Spares are used from the top down. */
  nextSpare: number;
}

class Store {
  m: Manifest | undefined;
  private log: (m: string) => void;

  constructor(log: (m: string) => void) {
    this.log = log;
  }

  private save() {
    mkdirSync("lab/legacy/state", { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify(this.m));
  }

  /** Uploads the meter frames + a fresh spare pool, unless the screen already holds them. */
  async ensure(s: Screen, force = false): Promise<Manifest> {
    const frames = meterFrames();
    const hash = createHash("sha256").update(Buffer.concat(frames)).digest("hex");
    if (!force && existsSync(MANIFEST)) {
      const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as Partial<Manifest>;
      const t = await s.readTable();
      if (m.hash === hash && m.allocated && m.nextSpare !== undefined && m.firstSpare !== undefined
        && t[9] === 1 && t[10] === m.allocated && m.nextSpare >= m.firstSpare) {
        this.m = m as Manifest;
        this.log(`meter frames already on the screen; ${this.sparesLeft()} spare blocks left`);
        return this.m;
      }
    }
    const kb = Math.round(frames.reduce((n, f) => n + f.length, 0) / 1024);
    this.log(`uploading ${frames.length} meter frames (${kb} KB) + ${POOL_BLOCKS} spare blocks; the screen shows "Downloading" for about a minute…`);
    const r = await s.uploadGifs(frames, { slots: 1, spareBlocks: POOL_BLOCKS });
    this.m = { hash, entries: r.entries, allocated: r.blocks, firstSpare: r.firstSpare, nextSpare: r.blocks - 1 };
    this.save();
    this.log(`uploaded in ${Math.round(Object.values(r.ms).reduce((a, b) => a + b, 0) / 1000)} s`);
    return this.m;
  }

  sparesLeft() {
    return this.m ? this.m.nextSpare - this.m.firstSpare + 1 : 0;
  }

  /** Hands out one never-used spare block, recording it BEFORE it's written. */
  takeSpare(): number | undefined {
    if (!this.m || this.sparesLeft() <= 0) return undefined;
    const b = this.m.nextSpare--;
    this.save();
    return b;
  }
}

export interface MeterOptions {
  log?: (m: string) => void;
  signal?: AbortSignal;
  /** ms after the last key press before the bar starts draining. */
  holdMs?: number;
  /** ms per segment while draining. */
  drainMs?: number;
  reupload?: boolean;
  /** Show a clock when idle (default true). */
  clock?: boolean;
  clockOptions?: ClockOptions;
  /** Register a key-press source; returns a stop function. */
  keys: (onKey: () => void) => () => void;
}

const minuteOf = (ms: number) => Math.floor(ms / 60000);

/** Runs the meter until the signal aborts. Reconnects if the screen drops off. */
export async function runMeter(opts: MeterOptions): Promise<void> {
  const { log = console.log, signal, holdMs = 500, drainMs = 200, clock = true } = opts;
  let charge = 0, lastKey = 0, lastDrain = 0, explodeUntil = 0, busy = false;
  const stopKeys = opts.keys(() => {
    if (busy || performance.now() < explodeUntil) return; // ignore typing while uploading or exploding
    charge = Math.min(LEVELS, charge + 1 / KEYS_PER_SEGMENT);
    lastKey = lastDrain = performance.now();
  });
  const store = new Store(log);
  const boomIndex = LEVELS + 1;
  let force = opts.reupload ?? false;
  try {
    while (!signal?.aborted) {
      let s: Screen | undefined;
      try {
        s = await Screen.connect(15000, log);
        busy = true;
        const m = await store.ensure(s, force);
        force = false;
        busy = false;
        const screen = s;
        const show = (e: SlotEntry) => screen.switchTable([e], m.allocated, "flip");

        // Clock faces: `current` is shown when idle; `next` is pre-written for the coming minute.
        let current: { minute: number; entry: SlotEntry } | undefined;
        let next: { minute: number; entry: SlotEntry } | undefined;
        const writeClock = async (minute: number) => {
          const block = store.takeSpare();
          if (block === undefined) return undefined;
          const gif = clockGif(new Date(minute * 60000), opts.clockOptions);
          const ms = await screen.writeImage(block, gif);
          log(`clock ${new Date(minute * 60000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} written to block ${block} in ${Math.round(ms)} ms (${store.sparesLeft()} spares left)`);
          return { minute, entry: { start: block, length: gif.length } };
        };
        if (clock) current = await writeClock(minuteOf(Date.now()));
        const idleEntry = () => current?.entry ?? m.entries[0];

        let shown: SlotEntry | undefined, lastTraffic = 0;
        charge = 0; // ignore anything typed while connecting or uploading
        log(clock ? "running: clock when idle, type to fill the bar" : "meter running: type to fill the bar");
        while (!signal?.aborted) {
          const now = performance.now(), wall = Date.now();

          if (clock) {
            const minute = minuteOf(wall);
            // Pool used up: re-upload everything with a fresh pool.
            if (store.sparesLeft() === 0 && !next && (!current || current.minute < minute)) {
              log("spare pool used up; re-uploading");
              force = true;
              break;
            }
            // Pre-write the next minute's face shortly before the minute turns.
            if (!next && (!current || current.minute <= minute) && wall % 60000 >= (60 - CLOCK_LEAD_S) * 1000) {
              next = await writeClock(minute + 1);
              lastTraffic = performance.now();
              continue;
            }
            // Minute turned: promote the pre-written face (or write one now if we missed it).
            if (!current || current.minute < minute) {
              current = next && next.minute === minute ? next : (await writeClock(minute)) ?? current;
              next = undefined;
              lastTraffic = performance.now();
              continue;
            }
          }

          if (charge >= LEVELS && now >= explodeUntil) {
            log("BOOM");
            await show(m.entries[boomIndex]);
            explodeUntil = performance.now() + EXPLOSION_SHOW_MS;
            await sleep(Math.max(0, explodeUntil - performance.now()));
            charge = 0;
            shown = undefined;
            continue;
          }
          if (charge > 0 && now - lastKey > holdMs && now - lastDrain > drainMs) {
            charge = Math.max(0, Math.ceil(charge) - 1); // drain one whole segment
            lastDrain = now;
          }
          const level = Math.floor(charge);
          const want = level === 0 ? idleEntry() : m.entries[level];
          if (shown !== want) {
            await show(want);
            shown = want;
            lastTraffic = performance.now();
          } else if (now - lastTraffic > 900) {
            await s.status(); // keepalive: the screen drops off USB after ~4 s of silence
            lastTraffic = performance.now();
          } else {
            await sleep(10);
          }
        }
      } catch (e) {
        log(`screen error: ${(e as Error).message}; reconnecting`);
        await sleep(1000);
      } finally {
        busy = false;
        s?.close();
      }
    }
  } finally {
    stopKeys();
  }
}

/**
 * Fake typing for testing without the input group: bursts with pauses, and every
 * third burst is long enough to fill the bar and set off the explosion.
 */
export function demoKeys(onKey: () => void): () => void {
  let stopped = false;
  (async () => {
    for (let n = 0; !stopped; n++) {
      const burst = n % 3 === 2 ? 40 : 6 + Math.floor(Math.random() * 14);
      for (let i = 0; i < burst && !stopped; i++) {
        onKey();
        await sleep(70 + Math.random() * 80);
      }
      await sleep(2500 + Math.random() * 1500);
    }
  })();
  return () => {
    stopped = true;
  };
}
