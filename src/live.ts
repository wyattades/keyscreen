// LiveScreen: show computer-generated frames on the QK108 screen, indefinitely, without the
// "Downloading" screen and (normally) without pausing.
//
// Flash it manages (blocks): [0 .. streamBlocks) main stream area, then parkBlocks parking blocks.
// Everything sits at the start of flash because the erase can only clear blocks 0..N-1.
//
// - Frames go into a growing QGIF ("stream") just ahead of the playhead (see stream.ts).
//   Unchanged frames cost 255 bytes.
// - When the main area is nearly full it rotates without pausing:
//     1. prepare a short stream in the next parking block (written in small slices between the
//        main stream's frames), then switch to it; updates keep flowing there;
//     2. erase the part of the main area the stream used (plain session, no Downloading);
//     3. prepare a fresh main stream at block 0 the same way, then switch back.
//   Each rotation uses up one parking block.
// - When the parking blocks are used up, it shows the permanent `fallback` frame while it erases
//   main + parking together (the only visible hiccup; rare with a big parking pool).
// - Erases must stay short: the screen can't answer USB while erasing, and an erase longer than
//   ~5 s made it drop off USB, and once froze it until a power cycle. An erase costs about
//   ERASE_MS_WRITTEN per block that holds data and ERASE_MS_BLANK per blank one, so rotations erase
//   only the blocks the stream used, and big erases go in chunks (see eraseUpTo).
import { sleep } from "./hidraw.ts";
import { QgifStream } from "./qgif.ts";
import type { Screen, SlotEntry } from "./qk108.ts";

export const LIVE_W = 240,
  LIVE_H = 136;
const BLOCK = 65536;
/** Background writes go out in slices this big, so the playing stream is never starved for long. */
const SLICE = 56 * 16;
/** "No change" frames written after a new stream's latest frame, before switching to it. */
const SWITCH_PADDING = 1;
/** Measured erase cost per block: ~137 ms if it holds data, ~56 ms if already blank. Rounded up. */
const ERASE_MS_WRITTEN = 140;
const ERASE_MS_BLANK = 60;
/** Longest single erase we send. ~5.5 s erases made the screen drop off USB; ~4 s ones never did. */
const MAX_ERASE_MS = 3500;
/** Rotate early, while nothing is changing, once the main area is this full. */
const IDLE_ROTATE_FILL = 0.5;
const IDLE_MS = 1000;
/**
 * If no write or erase finishes for this long, streaming has stalled (the screen stopped taking
 * data without an error; it happened once and went unnoticed for 22 h). The stream then fails, so
 * the service reconnects and, if the chip is frozen, says so. Longest normal gap: one erase, <4 s.
 */
const STALL_MS = 10_000;
/**
 * The screen reads ~0.3 s (3 frames) ahead of what it shows, plus a frame of margin. A frame must be
 * completely in flash before playback gets this close, or the screen decodes a half-written record
 * (see feed); that left it showing noise until a power cycle (2026-10-25).
 */
const READAHEAD_FRAMES = 4;

export interface LiveOptions {
  streamBlocks: number;
  parkBlocks: number;
  /** Total blocks allocated in the slot table (everything incl. permanent frames). */
  totalBlocks: number;
  /** Permanent frame (outside the managed area) shown while everything is erased. */
  fallback: SlotEntry;
  fps?: number;
  /** Frames to stay ahead of the playhead = display latency. */
  leadFrames?: number;
  /**
   * How long after a switch the screen actually starts playing frame 0 (measured ~0.7 s). The
   * playhead estimate is shifted by this much, so the buffer isn't padded by the start-up delay.
   * UNSAFE: 600 ms made the screen read unwritten flash (white, then garbled), because the screen
   * reads ahead rather than starting late. Keep at 0.
   */
  startDelayMs?: number;
  /**
   * EXPERIMENT, leave at 0: pads every streamed frame to at least this many bytes (re-sending unchanged
   * blocks). Measured to make the delay WORSE (580 ms -> ~900 ms), probably because the screen decodes slower.
   */
  padFrameBytes?: number;
  /**
   * The screen plays slightly slower than the declared fps (~1.1% measured at 10 fps), so the delay
   * creeps up over a stream's life. The playhead estimate is slowed by this factor to match. Stay
   * at or under the measured value: overestimating would write behind the real playhead.
   */
  playbackSlowdown?: number;
  /** Start a fresh stream (during an idle moment) once the current one is this old, to clear any creep. */
  maxStreamAgeMs?: number;
  /** Log every gap of >300 ms between new content on screen (useful in tests, noisy otherwise). */
  logGaps?: boolean;
  log?: (m: string) => void;
}

/** One growing QGIF in flash. */
class Stream {
  readonly block: number;
  readonly capacity: number;
  readonly enc = new QgifStream(LIVE_W, LIVE_H);
  offset = 0; // bytes written (or queued, while preparing)
  written = 0; // frames written
  t0 = 0; // performance.now() when it went on screen
  content: Uint8Array | undefined; // last image encoded into this stream

  constructor(block: number, blocks: number) {
    this.block = block;
    this.capacity = blocks * BLOCK;
  }
  get addr() {
    return this.block * BLOCK + this.offset;
  }
  get left() {
    return this.capacity - this.offset;
  }
  /** Blocks this stream has written into (all of them hold data). */
  get blocksUsed() {
    return Math.ceil(this.offset / BLOCK);
  }
  entry(): SlotEntry {
    return { start: this.block, length: this.capacity };
  }
}

type Phase = "main" | "prepPark" | "erase" | "prepMain";

export class LiveScreen {
  private s: Screen;
  private o: Required<Omit<LiveOptions, "log">> & { log: (m: string) => void };
  private active!: Stream;
  private preparing: Stream | undefined;
  private queue: { addr: number; data: Uint8Array }[] = [];
  private phase: Phase = "main";
  private parking: number[] = [];
  private pending: Uint8Array | undefined;
  private last: Uint8Array | undefined;
  private running = false;
  private loop: Promise<void> | undefined;
  private lastProgressAt = 0;
  /** Measured write speed (bytes per ms), for timing content writes; starts conservative. */
  private bytesPerMs = 25;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  stats = {
    contentFrames: 0,
    emptyFrames: 0,
    rotations: 0,
    fallbackRotations: 0,
    starvedMs: 0,
    maxBehindFrames: 0,
    maxContentGapMs: 0,
    /** "No change" frames added so a big frame finishes writing before playback reaches it. */
    leadPadding: 0,
  };
  private lastContentShowAt = 0;
  private lastPushAt = 0;
  private mainStream: Stream | undefined;

  constructor(screen: Screen, opts: LiveOptions) {
    this.s = screen;
    // Defaults from on-device tests: 10 fps (no frame-time rounding drift), 0.5 s buffer, no padding.
    this.o = {
      fps: 10,
      // 5: the screen reads ~3 frames ahead, so 3 (the old default) left a big frame no time to
      // finish writing; see READAHEAD_FRAMES. Costs ~0.2 s more delay.
      leadFrames: 5,
      startDelayMs: 0,
      padFrameBytes: 0,
      playbackSlowdown: 1.01,
      maxStreamAgeMs: 10 * 60_000,
      logGaps: false,
      log: () => {},
      ...opts,
    };
    // 2 packets in flight: ~37 KB/s (1 = ~18 KB/s, 4 = ~55 KB/s, USB's ceiling). Every mode needs
    // under 31 KB/s. 4 in flight was in use for both freezes during plain streaming (2026-10-23/24),
    // so this stays gentler until that's ruled out.
    this.s.writeWindow = 2;
  }

  private get frameMs() {
    return 1000 / this.o.fps;
  }
  private ahead(st: Stream) {
    return st.written - Math.floor((performance.now() - st.t0) / (this.frameMs * this.o.playbackSlowdown));
  }

  /** Erases main + parking while `showing` is on screen, then starts streaming `first`. */
  async start(first: Uint8Array, showing: SlotEntry = this.o.fallback) {
    this.last = first;
    await this.s.switchTable([showing], this.o.totalBlocks, "flip");
    await this.eraseAll(showing);
    const main = new Stream(0, this.o.streamBlocks);
    await this.writeNow(this.prepare(main, first));
    await this.finishForSwitch(main);
    await this.goLive(main);
    this.running = true;
    this.lastProgressAt = performance.now();
    const stalled = new Promise<never>((_, reject) => {
      this.watchdog = setInterval(() => {
        const ms = performance.now() - this.lastProgressAt;
        if (this.running && ms > STALL_MS) {
          this.running = false;
          reject(new Error(`stream stalled: nothing written for ${Math.round(ms / 1000)} s`));
        }
      }, 1000);
    });
    this.loop = Promise.race([this.pump(), stalled]).finally(() => clearInterval(this.watchdog));
  }

  /** Resolves when streaming stops; rejects if it fails (e.g. the screen stops answering). */
  get finished(): Promise<void> {
    return this.loop ?? Promise.resolve();
  }

  /** Queues a frame (RGBA 240x136); if several arrive before one can be written, the latest wins. */
  push(rgba: Uint8Array) {
    this.pending = rgba;
    this.lastPushAt = performance.now();
  }

  /** Stops streaming and shows `final` before the playhead can reach unwritten flash. */
  async stop(final: SlotEntry = this.o.fallback) {
    this.running = false;
    await this.loop;
    await this.s.switchTable([final], this.o.totalBlocks, "flip");
  }

  // ---- internals ----

  private async eraseAll(showing: SlotEntry) {
    const n = this.o.streamBlocks + this.o.parkBlocks;
    const r = await this.eraseUpTo(n, [showing]);
    this.parking = Array.from({ length: this.o.parkBlocks }, (_, i) => this.o.streamBlocks + i);
    this.o.log(`erased main + parking (${n} blocks) in ${r.ms} ms (${r.chunks} erase${r.chunks > 1 ? "s" : ""})`);
  }

  /** eraseInSteps, counting each finished erase as progress for the stall watchdog. */
  private async eraseUpTo(n: number, restore: SlotEntry[]) {
    return eraseInSteps(this.s, n, restore, this.o.totalBlocks, () => (this.lastProgressAt = performance.now()));
  }

  /** Estimated time for eraseUpTo(n) when every block holds data. */
  private eraseEstimateMs(n: number) {
    let done = 0,
      ms = 0;
    while (done < n) {
      const fresh = Math.max(1, Math.floor((MAX_ERASE_MS - done * ERASE_MS_BLANK) / ERASE_MS_WRITTEN));
      const upTo = Math.min(n, done + fresh);
      ms += done * ERASE_MS_BLANK + (upTo - done) * ERASE_MS_WRITTEN + 150;
      done = upTo;
    }
    return ms;
  }

  /** Header + keyframe for a new stream, as queued writes. Padding is added at switch time. */
  private prepare(st: Stream, first: Uint8Array) {
    const writes: { addr: number; data: Uint8Array }[] = [];
    const add = (data: Uint8Array) => {
      writes.push({ addr: st.addr, data });
      st.offset += data.length;
      st.written++;
    };
    add(st.enc.header(65535, this.o.fps));
    st.written = 0;
    add(st.enc.next(first).bytes);
    st.content = first;
    return writes;
  }

  /**
   * Right before switching to a prepared stream: add a frame with the latest content (if it changed
   * since the keyframe was made), then a little padding, so the screen shows at most one old frame.
   */
  private async finishForSwitch(st: Stream) {
    if (this.last && this.last !== st.content) {
      const { bytes } = st.enc.next(this.last, this.padFor(st));
      await this.s.writeAt(st.addr, bytes);
      st.offset += bytes.length;
      st.written++;
      st.content = this.last;
    }
    for (let i = 0; i < SWITCH_PADDING; i++) {
      const e = st.enc.empty(this.padFor(st));
      await this.s.writeAt(st.addr, e);
      st.offset += e.length;
      st.written++;
    }
  }

  private async writeNow(writes: { addr: number; data: Uint8Array }[]) {
    for (const w of writes) await this.s.writeAt(w.addr, w.data);
  }

  private async goLive(st: Stream) {
    await this.s.switchTable([st.entry()], this.o.totalBlocks, "flip");
    st.t0 = performance.now() + this.o.startDelayMs;
    this.active = st;
    if (st.block === 0) this.mainStream = st;
  }

  /** Appends one frame to the playing stream: new content if any and there's time, else "no change". */
  private async feed() {
    const st = this.active;
    const ahead = this.ahead(st);
    this.stats.maxBehindFrames = Math.max(this.stats.maxBehindFrames, this.o.leadFrames - ahead);
    // Keep room in a parking stream: only cheap empty frames once it's getting full.
    const roomForContent = st.left > 20000;
    // Fast writes (~40 ms for a typical frame) let us write content whenever it's waiting.
    if (this.pending && ahead >= 1 && roomForContent) {
      const rgba = this.pending;
      this.pending = undefined;
      const { bytes } = st.enc.next(rgba, this.padFor(st));
      // While this frame is being written, playback keeps moving. Make sure it (plus the screen's
      // read-ahead) can't reach the frame before it's all in flash: first add "no change" frames
      // until there's enough lead. Each costs ~7 ms to write and buys a whole frame of time.
      const writeFrames = Math.ceil(bytes.length / this.bytesPerMs / this.frameMs);
      const need = READAHEAD_FRAMES + writeFrames;
      let padded = 0;
      while (this.ahead(st) < need && st.left > bytes.length + 2000) {
        const e = st.enc.empty(this.padFor(st));
        await this.s.writeAt(st.addr, e);
        st.offset += e.length;
        st.written++;
        this.stats.emptyFrames++;
        padded++;
      }
      if (padded) this.stats.leadPadding += padded;
      const t0 = performance.now();
      await this.s.writeAt(st.addr, bytes);
      const ms = performance.now() - t0;
      // Big writes give a fair speed sample; average them so one hiccup doesn't swing it.
      if (bytes.length > 2000 && ms > 0) this.bytesPerMs = 0.8 * this.bytesPerMs + 0.2 * (bytes.length / ms);
      st.offset += bytes.length;
      this.last = rgba;
      st.content = rgba;
      this.stats.contentFrames++;
      // When this frame will be on screen, and the longest gap between new content on screen so far.
      const showAt = st.t0 + st.written * this.frameMs;
      if (this.lastContentShowAt && showAt > this.lastContentShowAt) {
        const gap = Math.round(showAt - this.lastContentShowAt);
        this.stats.maxContentGapMs = Math.max(this.stats.maxContentGapMs, gap);
        if (gap > 300 && this.o.logGaps)
          this.o.log(`content gap ${gap} ms (phase ${this.phase}, stream @ block ${st.block}, frame ${st.written})`);
      }
      this.lastContentShowAt = Math.max(this.lastContentShowAt, showAt);
    } else {
      if (st.left < 300) throw new Error("stream overflow");
      const bytes = st.enc.empty(this.padFor(st));
      await this.s.writeAt(st.addr, bytes);
      st.offset += bytes.length;
      this.stats.emptyFrames++;
    }
    st.written++;
    this.lastProgressAt = performance.now();
  }

  /** Writes up to SLICE bytes of queued background work. */
  private async writeSlice() {
    const w = this.queue[0];
    const n = Math.min(SLICE, w.data.length);
    await this.s.writeAt(w.addr, w.data.subarray(0, n));
    if (n === w.data.length) this.queue.shift();
    else this.queue[0] = { addr: w.addr + n, data: w.data.subarray(n) };
  }

  /** Changes frame padding on the fly (see padFrameBytes). */
  setPad(bytes: number) {
    this.o.padFrameBytes = Math.max(0, bytes);
  }

  /** Padding for a frame in `st`: none in (small) parking streams or when the stream is nearly full. */
  private padFor(st: Stream) {
    const pad = this.o.padFrameBytes;
    if (!pad || st.block !== 0) return 0;
    return st.left > 40000 + pad * 16 ? pad : 0;
  }

  /** Changes the buffer ahead of the playhead (= display latency) on the fly. */
  setLead(frames: number) {
    this.o.leadFrames = Math.max(1, frames);
  }

  private async pump() {
    while (this.running) {
      const lead = this.o.leadFrames;
      const ahead = this.ahead(this.active);
      if (ahead < 1) this.stats.starvedMs += this.frameMs; // rough: playhead caught up
      if (ahead <= lead) {
        await this.feed();
        continue;
      }
      if (this.queue.length) {
        await this.writeSlice();
        continue;
      }
      if (await this.advanceRotation()) continue;
      await sleep(5);
    }
  }

  /** Moves the rotation state machine one step. Returns true if it did something. */
  private async advanceRotation(): Promise<boolean> {
    const reserve = 17000 + Math.max(300, this.o.padFrameBytes) * (this.o.leadFrames + 64);
    switch (this.phase) {
      case "main": {
        const idle = performance.now() - this.lastPushAt > IDLE_MS && !this.pending;
        const fullEnough = this.active.offset > this.active.capacity * IDLE_ROTATE_FILL;
        const aged = performance.now() - this.active.t0 > this.o.maxStreamAgeMs;
        const early = idle && (fullEnough || aged) && this.active === this.mainStream && this.parking.length > 0;
        if (this.active.left >= reserve && !early) return false;
        if (early) this.o.log(`rotate: early, while idle (${aged ? "stream aged" : "half full"})`);
        const block = this.parking.shift();
        if (block === undefined) {
          await this.fallbackRotate();
          return true;
        }
        this.preparing = new Stream(block, 1);
        this.queue.push(...this.prepare(this.preparing, this.last!));
        this.phase = "prepPark";
        this.o.log(`rotate: preparing parking stream in block ${block} (${this.parking.length} parking left)`);
        return true;
      }
      case "prepPark": {
        // Queue drained: the parking stream is ready. Switch to it; updates continue there.
        await this.finishForSwitch(this.preparing!);
        await this.goLive(this.preparing!);
        this.preparing = undefined;
        this.phase = "erase";
        return true;
      }
      case "erase": {
        // Only the blocks the old main stream wrote hold data; the rest are still blank.
        const used = Math.max(1, Math.min(this.o.streamBlocks, this.mainStream?.blocksUsed ?? this.o.streamBlocks));
        // Make sure the parking stream has plenty of lead to cover the blocking erase.
        const eraseMs = this.eraseEstimateMs(used) + 300;
        // The normal buffer already covers part of the erase; only pad up to whichever is larger.
        if (this.ahead(this.active) < Math.max(this.o.leadFrames, Math.ceil(eraseMs / this.frameMs) + 1)) {
          await this.feed();
          return true;
        }
        const r = await this.eraseUpTo(used, [this.active.entry()]);
        this.o.log(`rotate: erased the ${used} used main blocks in ${r.ms} ms while the parking stream played`);
        this.preparing = new Stream(0, this.o.streamBlocks);
        this.queue.push(...this.prepare(this.preparing, this.last!));
        this.phase = "prepMain";
        return true;
      }
      case "prepMain": {
        await this.finishForSwitch(this.preparing!);
        await this.goLive(this.preparing!);
        this.preparing = undefined;
        this.phase = "main";
        this.stats.rotations++;
        this.o.log("rotate: back on a fresh main stream");
        return true;
      }
    }
  }

  private async fallbackRotate() {
    const t = performance.now();
    await this.s.switchTable([this.o.fallback], this.o.totalBlocks, "flip");
    await this.eraseAll(this.o.fallback);
    const main = new Stream(0, this.o.streamBlocks);
    this.last = this.pending ?? this.last!;
    this.pending = undefined;
    await this.writeNow(this.prepare(main, this.last));
    await this.finishForSwitch(main);
    await this.goLive(main);
    this.stats.fallbackRotations++;
    this.o.log(`rotate: parking used up; showed the fallback frame for ${Math.round(performance.now() - t)} ms`);
  }
}

/**
 * Erases blocks 0..n-1 (treating them all as written), in as few erases as keep each one under
 * MAX_ERASE_MS. The erase always starts at block 0, so each step re-erases the already-blank
 * blocks before it, which is cheap. A status ping between steps keeps the screen awake.
 * `restore` is the slot table to leave in place (what's showing).
 */
export async function eraseInSteps(
  s: Screen,
  n: number,
  restore: SlotEntry[],
  totalBlocks: number,
  onStep: () => void = () => {},
) {
  let done = 0,
    chunks = 0,
    ms = 0;
  while (done < n) {
    const fresh = Math.max(1, Math.floor((MAX_ERASE_MS - done * ERASE_MS_BLANK) / ERASE_MS_WRITTEN));
    const upTo = Math.min(n, done + fresh);
    const r = await s.funcErase(upTo, restore, totalBlocks);
    ms += r.eraseMs;
    chunks++;
    done = upTo;
    onStep();
    if (done < n) await s.status();
  }
  return { ms, chunks };
}
