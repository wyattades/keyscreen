// Shared helpers for on-device test cases.
import { sleep } from "../src/hidraw.ts";
import { Screen, type SlotEntry } from "../src/qk108.ts";
import { encodeQgif } from "../src/qgif.ts";
import type { Step } from "./sheet.ts";
import { bigText } from "./frames.ts";
import { loadLayout, type Layout } from "../src/layout.ts";

export interface TestCase {
  id: string;
  title: string;
  /** One or two plain sentences: what this checks and why it matters. */
  description: string;
  /** What success looks like, in words, using the picture's step numbers. */
  success: string;
  /** Screens the user should see, in order (rendered into the dashboard picture). */
  expect: () => Step[];
  /** Runs on the keyboard. Throw to fail. */
  run: (t: TestContext) => Promise<void>;
  /** Archived cases stay listed with their history but can't be run. */
  archived?: string;
  /** Read-only tests change nothing on screen. */
  readOnly?: boolean;
  /** Runs without the test layout (e.g. the setup case that creates it). */
  noLayout?: boolean;
  /** If set, the dashboard shows a drawing pad while this runs; the string is shown as a hint. */
  interactive?: string;
  /**
   * If set, the dashboard shows a big SEEN button (sends "seen <epochMs>") and a flash box that lights
   * up at times the test prints as "FLASHAT <epochMs>". The string is shown as a hint.
   */
  react?: string;
}

export interface TestContext {
  s: Screen;
  log: (m: string) => void;
  /** Wait while keeping the screen connected (pings every ~0.9 s). */
  idle: (ms: number) => Promise<void>;
  /** Show any stored image for `ms`, then log `label`. */
  show: (entry: SlotEntry, label: string, ms: number) => Promise<void>;
  layout: Layout;
  /** Calls `cb` for every input line from the dashboard ("dot x y", "clear", "lead n", "seen <epochMs>"). */
  onInput: (cb: (line: string) => void) => void;
}

// The flash layout is shared with the screen service (src/layout.ts). Tests use the first
// SCRATCH_BLOCKS of its managed area for their own erases and streams.
export type { Layout } from "../src/layout.ts";
export { LAYOUT_FILE, PERMANENT_FRAMES, loadLayout } from "../src/layout.ts";
export const SCRATCH_BLOCKS = 16;

/** One-frame QGIF of big text. */
export const textGif = (text: string) => encodeQgif([{ rgba: bigText(text) }], { width: 240, height: 136, fps: 1 });

export async function withContext(log: (m: string) => void, needsLayout: boolean, fn: (t: TestContext) => Promise<void>) {
  const layout = loadLayout();
  if (needsLayout && !layout) throw new Error("No flash layout yet (or an old one). Run 'One-time setup' first.");
  const s = await Screen.connect(15000, log);
  try {
    const idle = async (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        await s.status();
        await sleep(Math.min(900, Math.max(0, end - performance.now())));
      }
    };
    const show = async (entry: SlotEntry, label: string, ms: number) => {
      await s.switchTable([entry], layout?.total ?? 1, "flip");
      log(label);
      await idle(ms);
    };
    // Health check first, so a frozen chip gives a clear message instead of a confusing mid-test failure.
    try {
      await s.status();
    } catch {
      throw new Error("Screen chip not responding. Power-cycle the keyboard (unplug USB, power switch off ~10 s, back on), then run 'Is the screen chip responding?'.");
    }
    const onInput = (cb: (line: string) => void) => {
      process.stdin.setEncoding("utf8");
      let buf = "";
      process.stdin.on("data", (d: string) => {
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) if (line.trim()) cb(line.trim());
      });
    };
    await fn({ s, log, idle, show, layout: layout ?? ({ total: 0, managed: 0, frames: {} } as unknown as Layout), onInput });
  } finally {
    s.close();
  }
}

export const hex = (b: Uint8Array, from = 0, n = 24) => Buffer.from(b.subarray(from, from + n)).toString("hex").replace(/(..)/g, "$1 ").trim();
