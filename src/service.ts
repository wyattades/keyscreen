// ScreenService: owns the keyboard screen and shows whatever it's given, live, forever.
// Connects, makes sure the flash layout exists, streams the current picture with LiveScreen, and
// reconnects on its own if the screen stops answering.
import { sleep } from "./hidraw.ts";
import { ensureLayout } from "./layout.ts";
import { LiveScreen } from "./live.ts";
import { decodePng, fitImage, isPng } from "./png.ts";
import { Screen } from "./qk108.ts";
import { renderText, type TextOptions } from "./textframe.ts";
import { fakeLayout, fakeScreen } from "./fake-screen.ts";

export const SCREEN_W = 240,
  SCREEN_H = 136;

export type ServiceState = "starting" | "setting up" | "running" | "reconnecting" | "stopped";

export class ScreenService {
  state: ServiceState = "starting";
  lastError = "";
  /** The picture currently being shown (or about to be), RGBA 240x136. */
  current: Uint8Array = renderText("");
  updatedAt = 0;
  private live: LiveScreen | undefined;
  private log: (m: string) => void;
  private stopping = false;

  private fake: boolean;

  /** `fake`: run against a simulated screen (no USB); also enabled by FAKE_SCREEN=1. */
  constructor(log: (m: string) => void = console.log, opts: { fake?: boolean } = {}) {
    this.log = log;
    this.fake = opts.fake ?? process.env.FAKE_SCREEN === "1";
  }

  get stats() {
    return this.live?.stats;
  }

  /** Shows an RGBA frame (240x136, or 240x135 which is padded with a black row). */
  showRgba(rgba: Uint8Array) {
    if (rgba.length === SCREEN_W * 135 * 4) {
      const padded = new Uint8Array(SCREEN_W * SCREEN_H * 4);
      padded.set(rgba);
      for (let i = SCREEN_W * 135; i < SCREEN_W * SCREEN_H; i++) padded[i * 4 + 3] = 255;
      rgba = padded;
    }
    if (rgba.length !== SCREEN_W * SCREEN_H * 4)
      throw new Error(`expected ${SCREEN_W}x${SCREEN_H} RGBA (${SCREEN_W * SCREEN_H * 4} bytes), got ${rgba.length}`);
    this.current = rgba;
    this.updatedAt = Date.now();
    this.live?.push(rgba);
  }

  /** Shows a PNG (any size; scaled to fit) or raw RGBA bytes. */
  showImage(bytes: Uint8Array) {
    this.showRgba(isPng(bytes) ? fitImage(decodePng(bytes)) : bytes);
  }

  showText(text: string, opts?: TextOptions) {
    this.showRgba(renderText(text, opts));
  }

  /** Runs until stop(): connect, stream, and reconnect after failures. */
  async run() {
    while (!this.stopping) {
      let s: Screen | undefined;
      try {
        this.state = "starting";
        s = this.fake ? fakeScreen() : await Screen.connect(15000, this.log);
        this.state = "setting up";
        const layout = this.fake ? fakeLayout : await ensureLayout(s, this.log);
        this.live = new LiveScreen(s, {
          streamBlocks: layout.managed - 8,
          parkBlocks: 8,
          totalBlocks: layout.total,
          fallback: layout.frames.BLANK,
          log: this.log,
        });
        await this.live.start(this.current, layout.frames.BLANK);
        this.state = "running";
        this.lastError = "";
        this.log("screen service running");
        await this.live.finished;
      } catch (e) {
        this.lastError = (e as Error).message;
        this.log(`screen error: ${this.lastError}`);
      } finally {
        this.live = undefined;
        s?.close();
      }
      if (!this.stopping) {
        this.state = "reconnecting";
        await sleep(2000);
      }
    }
    this.state = "stopped";
  }

  /** Stops streaming and leaves the blank frame on screen. */
  async stop() {
    this.stopping = true;
    await this.live?.stop();
  }
}
