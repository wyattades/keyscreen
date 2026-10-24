// ScreenService: owns the keyboard screen and shows whatever it's given, live, forever.
// Connects, makes sure the flash layout exists, streams the current picture with LiveScreen, and
// reconnects on its own if the screen stops answering.
import { readdirSync, readFileSync } from "node:fs";
import { sleep } from "./hidraw.ts";
import { ensureLayout } from "./layout.ts";
import { LiveScreen } from "./live.ts";
import { decodePng, fitImage, isPng } from "./png.ts";
import { Screen } from "./qk108.ts";
import { renderText, type TextOptions } from "./textframe.ts";
import { fakeLayout, fakeScreen } from "./fake-screen.ts";

export const SCREEN_W = 240,
  SCREEN_H = 136;

export type ServiceState =
  | "starting"
  | "setting up"
  | "running"
  | "reconnecting"
  /** The keyboard isn't on USB. */
  | "no keyboard"
  /** The screen chip stopped answering; only a power cycle brings it back. */
  | "frozen"
  | "stopped";

/** Failed connects in a row before we call the screen chip frozen and stop retrying. */
const FROZEN_AFTER = 3;
/** While frozen, one more try this often anyway. */
const RETRY_FROZEN_MS = 5 * 60_000;
export const FROZEN_HELP =
  "The keyboard's screen chip stopped responding. Power-cycle the keyboard: unplug the USB cable, switch the keyboard off for 10 seconds, then switch it on and plug it back in. (If Epomaker Hub or image.rdmctmzt.com is open in a browser, close it.) The server carries on by itself once the keyboard reconnects.";

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
    let fails = 0;
    while (!this.stopping) {
      if (!this.fake) {
        if (!keyboardUsbId()) {
          this.state = "no keyboard";
          this.lastError = "The keyboard isn't connected by USB.";
          await sleep(3000);
          continue;
        }
        if (fails >= FROZEN_AFTER) {
          await this.waitForReplug();
          fails = 0;
          continue;
        }
      }
      let s: Screen | undefined;
      try {
        this.state = "starting";
        s = this.fake ? fakeScreen() : await Screen.connect(15000, this.log);
        this.state = "setting up";
        const layout = this.fake ? fakeLayout : await ensureLayout(s, this.log);
        this.live = new LiveScreen(s, {
          // Half and half: a full main area stays a short erase (see live.ts), and 24 parking
          // blocks mean ~24 rotations between the fallback-frame hiccups.
          streamBlocks: layout.managed / 2,
          parkBlocks: layout.managed / 2,
          totalBlocks: layout.total,
          fallback: layout.frames.BLANK,
          log: this.log,
        });
        await this.live.start(this.current, layout.frames.BLANK);
        this.state = "running";
        this.lastError = "";
        fails = 0;
        this.log("screen service running");
        await this.live.finished;
      } catch (e) {
        this.lastError = (e as Error).message;
        this.log(`screen error: ${this.lastError}`);
        if (this.state !== "running") fails++;
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

  /**
   * The screen chip is stuck: stop talking to it (retries can't help, and only spam the USB bus) and
   * wait until it's been power-cycled. Signs of that, read from sysfs without touching the device:
   * the screen chip shows up on USB as a new device (it does so by itself for ~1 s after booting,
   * even when the keyboard stays plugged in), or the keyboard itself reconnects. As a backstop in
   * case both are missed, it tries once more every RETRY_FROZEN_MS.
   */
  private async waitForReplug() {
    const keyboardBefore = keyboardUsbId();
    const screenBefore = keyboardUsbId("1919", "1919");
    const since = performance.now();
    this.state = "frozen";
    this.lastError = FROZEN_HELP;
    this.log(`screen chip frozen after ${FROZEN_AFTER} failed connects; waiting for the keyboard to be power-cycled`);
    while (!this.stopping) {
      await sleep(400);
      const keyboard = keyboardUsbId(),
        screen = keyboardUsbId("1919", "1919");
      const why =
        keyboard && keyboard !== keyboardBefore
          ? "keyboard reconnected"
          : screen && screen !== screenBefore
            ? "screen chip restarted"
            : performance.now() - since > RETRY_FROZEN_MS
              ? "retrying in case the restart was missed"
              : "";
      if (why) {
        this.log(`${why}; trying the screen again`);
        await sleep(3000); // let it finish booting
        return;
      }
    }
  }

  /** Stops streaming and leaves the blank frame on screen. */
  async stop() {
    this.stopping = true;
    await this.live?.stop();
  }
}

/**
 * Identifies a USB device's current connection (sysfs name + device number), or "" if it's not
 * connected. Changes whenever it re-enumerates. Reads sysfs only; never talks to the device.
 * Defaults to the keyboard; ("1919", "1919") is its screen chip.
 */
export function keyboardUsbId(vendor = "36b0", product = "30af"): string {
  try {
    for (const d of readdirSync("/sys/bus/usb/devices")) {
      const dir = `/sys/bus/usb/devices/${d}`;
      try {
        if (readFileSync(`${dir}/idVendor`, "utf8").trim() !== vendor) continue;
        if (readFileSync(`${dir}/idProduct`, "utf8").trim() !== product) continue;
        return `${d}#${readFileSync(`${dir}/devnum`, "utf8").trim()}`;
      } catch {}
    }
  } catch {}
  return "";
}
