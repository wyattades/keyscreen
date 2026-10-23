// Live frames on the QK108 screen without download mode.
//
// The screen plays QGIF animations straight from flash, frame by frame, and each QGIF frame only
// stores the 4x4 tiles that changed. So we write the start of a long animation into erased flash,
// show it, and keep appending frames just ahead of the playhead while it plays. When there's no
// new content (or we're short on time), we append a "nothing changed" frame (bitmap only, 255 B).
//
// Limits: needs an erased flash region (erasing needs download mode, so do it rarely), and the
// playhead must never reach unwritten flash, so stop() flips away before the buffer runs out.
import { sleep } from "../../src/hidraw.ts";
import { QgifStream } from "../../src/qgif.ts";
import type { Screen, SlotEntry } from "../../src/qk108.ts";

export const STREAM_W = 240, STREAM_H = 136;

export interface StreamOptions {
  /** First block of an ERASED flash region, and how many 64 KiB blocks it spans. */
  startBlock: number;
  blocks: number;
  /** Total blocks allocated in the slot table (passed through to flips). */
  totalBlocks: number;
  /** Frame to show when stopping (outside the stream region). */
  restEntry: SlotEntry;
  /** Animation frame rate. The playhead advances at this rate whether or not content changes. */
  fps?: number;
  /** How far ahead of the playhead to stay, in frames. Also the display latency. */
  leadFrames?: number;
  log?: (m: string) => void;
}

export interface FrameEvent {
  /** Animation frame index this content was written into. */
  frame: number;
  /** Wall-clock time (ms since epoch) the screen should show it. */
  showAt: number;
  bytes: number;
  changedTiles: number;
  writeMs: number;
}

export class FrameStreamer {
  private s: Screen;
  private o: Required<Omit<StreamOptions, "log">> & { log: (m: string) => void };
  private enc = new QgifStream(STREAM_W, STREAM_H);
  private offset = 0; // bytes written into the region
  private written = 0; // animation frames written (next frame index)
  private t0 = 0; // when frame 0 was shown (performance.now())
  private wall0 = 0; // same, as Date.now()
  private pending: Uint8Array | undefined;
  private running = false;
  private loop: Promise<void> | undefined;
  stats = { contentFrames: 0, emptyFrames: 0, maxBehind: 0 };

  constructor(screen: Screen, opts: StreamOptions) {
    this.s = screen;
    this.o = { fps: 8, leadFrames: 8, log: () => {}, ...opts };
  }

  private get frameMs() {
    return 1000 / this.o.fps;
  }

  private get capacity() {
    return this.o.blocks * 65536;
  }

  /** Bytes of the region still unwritten. */
  get bytesLeft() {
    return this.capacity - this.offset;
  }

  /** Playhead position (animation frame currently on screen). */
  playhead() {
    return Math.floor((performance.now() - this.t0) / this.frameMs);
  }

  private async append(bytes: Uint8Array): Promise<number> {
    if (this.offset + bytes.length > this.capacity) throw new Error("stream region full");
    const ms = await this.s.writeAt(this.o.startBlock * 65536 + this.offset, bytes);
    this.offset += bytes.length;
    this.written++;
    return ms;
  }

  /** Writes the header + first frame + a lead of empty frames, then shows the stream. */
  async start(first: Uint8Array): Promise<void> {
    await this.s.writeAt(this.o.startBlock * 65536, this.enc.header(65535, this.o.fps));
    this.offset = 10;
    await this.append(this.enc.next(first).bytes);
    for (let i = 0; i < this.o.leadFrames; i++) await this.append(this.enc.empty());
    await this.s.switchTable([{ start: this.o.startBlock, length: this.capacity }], this.o.totalBlocks, "flip");
    this.t0 = performance.now();
    this.wall0 = Date.now();
    this.running = true;
  }

  /** Queues a new frame; the latest one wins if several arrive before it can be written. */
  push(rgba: Uint8Array) {
    this.pending = rgba;
  }

  /**
   * Keeps appending frames until stopped or the region is nearly full. `onFrame` fires for each
   * content frame written. Resolves when the stream stops.
   */
  run(onFrame?: (e: FrameEvent) => void, onIdle?: () => void): Promise<void> {
    this.loop = (async () => {
      const lead = this.o.leadFrames;
      // A content frame can be up to ~16.6 KB; keep that much room plus the lead's empty frames.
      const reserve = 17000 + 300 * (lead + 4);
      while (this.running && this.bytesLeft > reserve) {
        const ahead = this.written - this.playhead();
        this.stats.maxBehind = Math.max(this.stats.maxBehind, lead - ahead);
        if (ahead > lead) {
          onIdle?.();
          await sleep(5);
          continue;
        }
        // Only spend time on content when we have at least half the lead in hand.
        if (this.pending && ahead >= lead / 2) {
          const rgba = this.pending;
          this.pending = undefined;
          const frame = this.written;
          const { bytes, changed } = this.enc.next(rgba);
          const writeMs = await this.append(bytes);
          this.stats.contentFrames++;
          onFrame?.({ frame, showAt: this.wall0 + frame * this.frameMs, bytes: bytes.length, changedTiles: changed, writeMs });
        } else {
          await this.append(this.enc.empty());
          this.stats.emptyFrames++;
        }
      }
      if (this.running) this.o.log("stream region nearly full; stopping");
    })();
    return this.loop;
  }

  private stopping: Promise<void> | undefined;

  /**
   * Stops appending and flips to the rest frame before the playhead reaches unwritten flash.
   * Safe to call more than once; later calls wait for the first.
   */
  stop(): Promise<void> {
    this.running = false;
    this.stopping ??= (async () => {
      await this.loop;
      await this.s.switchTable([this.o.restEntry], this.o.totalBlocks, "flip");
    })();
    return this.stopping;
  }
}
