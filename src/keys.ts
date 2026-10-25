// Key-press events from the QK108's evdev devices (access via the udev rule, 70-keyscreen.rules).
// Only reports that a key went down; callers never get key codes.
// Reads are non-blocking and polled, so stopping never leaves a stuck read behind.
import { closeSync, constants, openSync, readFileSync, readSync, readdirSync } from "node:fs";

const EV_KEY = 1;
const EVENT_SIZE = 24; // struct input_event on 64-bit: timeval(16) + type(2) + code(2) + value(4)
const KEY_DOWN = 1;

/** /dev/input/eventN nodes for the QK108 that produce key events. */
export function keyboardEventNodes(): string[] {
  const out: string[] = [];
  for (const name of readdirSync("/sys/class/input")
    .filter((n) => n.startsWith("event"))
    .sort()) {
    try {
      const id = `/sys/class/input/${name}/device/id`;
      if (readFileSync(`${id}/vendor`, "utf8").trim() !== "36b0") continue;
      if (readFileSync(`${id}/product`, "utf8").trim() !== "30af") continue;
      // Only devices with letter keys (KEY_A = 30), not media/system/mouse.
      const keyBits = readFileSync(`/sys/class/input/${name}/device/capabilities/key`, "utf8").trim().split(" ");
      const lowWord = BigInt(`0x${keyBits[keyBits.length - 1] || "0"}`);
      if ((lowWord >> 30n) & 1n) out.push(`/dev/input/${name}`);
    } catch {
      // device vanished; skip
    }
  }
  return out;
}

/**
 * Calls onKeyDown once per key press (not repeats or releases) on any QK108
 * keyboard device. Returns a function that stops listening.
 */
export function onKeyDown(onKeyDown: () => void, onError: (e: Error) => void = () => {}): () => void {
  const nodes = keyboardEventNodes();
  if (!nodes.length) throw new Error("no QK108 key event devices found");
  const fds = nodes.map((path) => {
    try {
      return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw code === "EACCES"
        ? new Error(`${path}: permission denied. Is the udev rule installed (desktop/install.sh)?`)
        : e;
    }
  });
  const buf = Buffer.alloc(EVENT_SIZE * 64);
  const timer = setInterval(() => {
    for (const fd of fds) {
      for (;;) {
        let n: number;
        try {
          n = readSync(fd, buf, 0, buf.length, null);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EAGAIN") onError(e as Error);
          break;
        }
        for (let off = 0; off + EVENT_SIZE <= n; off += EVENT_SIZE) {
          if (buf.readUInt16LE(off + 16) === EV_KEY && buf.readInt32LE(off + 20) === KEY_DOWN) onKeyDown();
        }
        if (n < buf.length) break;
      }
    }
  }, 5);
  return () => {
    clearInterval(timer);
    for (const fd of fds) closeSync(fd);
  };
}

// ---- Key codes -> characters (US layout), for showing what's typed ----

const PLAIN: Record<number, string> = {
  2: "1",
  3: "2",
  4: "3",
  5: "4",
  6: "5",
  7: "6",
  8: "7",
  9: "8",
  10: "9",
  11: "0",
  12: "-",
  13: "=",
  16: "Q",
  17: "W",
  18: "E",
  19: "R",
  20: "T",
  21: "Y",
  22: "U",
  23: "I",
  24: "O",
  25: "P",
  26: "(",
  27: ")",
  30: "A",
  31: "S",
  32: "D",
  33: "F",
  34: "G",
  35: "H",
  36: "J",
  37: "K",
  38: "L",
  39: ";",
  40: "'",
  41: "'",
  43: "/",
  44: "Z",
  45: "X",
  46: "C",
  47: "V",
  48: "B",
  49: "N",
  50: "M",
  51: ",",
  52: ".",
  53: "/",
  57: " ",
  55: "*",
  71: "7",
  72: "8",
  73: "9",
  74: "-",
  75: "4",
  76: "5",
  77: "6",
  78: "+",
  79: "1",
  80: "2",
  81: "3",
  82: "0",
  83: ".",
  98: "/",
};
const SHIFTED: Record<number, string> = {
  2: "!",
  3: "@",
  4: "#",
  5: "$",
  6: "%",
  7: "^",
  8: "&",
  9: "*",
  10: "(",
  11: ")",
  12: "_",
  13: "+",
  39: ":",
  40: '"',
  51: "<",
  52: ">",
  53: "?",
};
const SHIFT_KEYS = new Set([42, 54]);
export const KEY_BACKSPACE = 14,
  KEY_ENTER = 28;

/**
 * Calls `onChar` with the character for each key press on the QK108 (shift-aware, uppercase),
 * or "\b" for Backspace and "\n" for Enter. Key presses with no printable character are ignored.
 * Needs read access to its /dev/input nodes (the udev rule). Returns a stop function.
 */
export function onTypedChar(onChar: (ch: string) => void, onError: (e: Error) => void = () => {}): () => void {
  const nodes = keyboardEventNodes();
  if (!nodes.length) throw new Error("no QK108 key event devices found");
  const fds = nodes.map((path) => {
    try {
      return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw code === "EACCES" ? new Error(`${path}: no permission (install the udev rule: desktop/install.sh)`) : e;
    }
  });
  let shift = 0,
    lastCode = -1,
    lastAt = 0;
  const buf = Buffer.alloc(EVENT_SIZE * 64);
  const timer = setInterval(() => {
    for (const fd of fds) {
      for (;;) {
        let n: number;
        try {
          n = readSync(fd, buf, 0, buf.length, null);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EAGAIN") onError(e as Error);
          break;
        }
        for (let off = 0; off + EVENT_SIZE <= n; off += EVENT_SIZE) {
          if (buf.readUInt16LE(off + 16) !== EV_KEY) continue;
          const code = buf.readUInt16LE(off + 18),
            value = buf.readInt32LE(off + 20);
          if (SHIFT_KEYS.has(code)) {
            shift += value === 1 ? 1 : value === 0 ? -1 : 0;
            shift = Math.max(0, shift);
            continue;
          }
          if (value !== KEY_DOWN) continue;
          // The QK108 can report a key on both of its keyboard interfaces; ignore the echo.
          const now = performance.now();
          if (code === lastCode && now - lastAt < 25) continue;
          lastCode = code;
          lastAt = now;
          if (code === KEY_BACKSPACE) onChar("\b");
          else if (code === KEY_ENTER || code === 96) onChar("\n");
          else {
            const ch = (shift && SHIFTED[code]) || PLAIN[code];
            if (ch) onChar(ch);
          }
        }
        if (n < buf.length) break;
      }
    }
  }, 5);
  return () => {
    clearInterval(timer);
    for (const fd of fds) closeSync(fd);
  };
}
