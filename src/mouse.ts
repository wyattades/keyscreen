// Mouse movement, buttons and wheel from evdev (access via the udev rule, 70-keyscreen.rules), plus a tracker that turns
// movement into an approximate pointer position. On Wayland, programs can't ask where the pointer
// is, so the tracker adds up the raw movement and clamps it to the desktop: pushing the mouse into
// a screen edge lines it up with the real pointer again.
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, readSync, readdirSync } from "node:fs";

const EV_KEY = 1,
  EV_REL = 2;
const REL_X = 0,
  REL_Y = 1,
  REL_WHEEL = 8;
export const BTN_LEFT = 272,
  BTN_RIGHT = 273,
  BTN_MIDDLE = 274;
const EVENT_SIZE = 24;

export interface MouseHandlers {
  move?: (dx: number, dy: number) => void;
  button?: (button: number, down: boolean) => void;
  wheel?: (steps: number) => void;
}

/** /dev/input/eventN nodes that move like a mouse (relative X and Y), except the keyboard's screen chip. */
export function mouseEventNodes(): string[] {
  const out: string[] = [];
  for (const name of readdirSync("/sys/class/input").filter((n) => n.startsWith("event"))) {
    try {
      const dev = `/sys/class/input/${name}/device`;
      if (readFileSync(`${dev}/id/vendor`, "utf8").trim() === "1919") continue;
      const rel = BigInt(`0x${readFileSync(`${dev}/capabilities/rel`, "utf8").trim().split(" ").pop() || "0"}`);
      if ((rel & 3n) === 3n) out.push(`/dev/input/${name}`);
    } catch {}
  }
  return out;
}

/** Calls the handlers for every mouse event. Returns a function that stops listening. */
export function onMouse(h: MouseHandlers, onError: (e: Error) => void = () => {}): () => void {
  const nodes = mouseEventNodes();
  if (!nodes.length) throw new Error("no mouse found");
  const fds = nodes.map((path) => {
    try {
      return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (e) {
      throw (e as NodeJS.ErrnoException).code === "EACCES"
        ? new Error(`${path}: permission denied (install the udev rule: desktop/install.sh)`)
        : e;
    }
  });
  const buf = Buffer.alloc(EVENT_SIZE * 128);
  const timer = setInterval(() => {
    let dx = 0,
      dy = 0;
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
          const type = buf.readUInt16LE(off + 16),
            code = buf.readUInt16LE(off + 18),
            value = buf.readInt32LE(off + 20);
          if (type === EV_REL && code === REL_X) dx += value;
          else if (type === EV_REL && code === REL_Y) dy += value;
          else if (type === EV_REL && code === REL_WHEEL) h.wheel?.(value);
          else if (type === EV_KEY && code >= BTN_LEFT && code <= BTN_MIDDLE && value !== 2)
            h.button?.(code, value === 1);
        }
        if (n < buf.length) break;
      }
    }
    if (dx || dy) h.move?.(dx, dy);
  }, 10);
  return () => {
    clearInterval(timer);
    for (const fd of fds) closeSync(fd);
  };
}

/** The desktop's size in pixels (all monitors), from XWayland's xrandr; 1920x1080 if unknown. */
export function desktopSize(): { w: number; h: number } {
  const r = spawnSync("xrandr", ["--current"], { encoding: "utf8", timeout: 2000 });
  const m = /current (\d+) x (\d+)/.exec(r.stdout ?? "");
  return m ? { w: +m[1], h: +m[2] } : { w: 1920, h: 1080 };
}

/** Approximate pointer position (0-1 across the desktop) from raw mouse movement. */
export class PointerTracker {
  x = 0.5;
  y = 0.5;
  /** performance.now() of the last movement. */
  movedAt = 0;
  private w: number;
  private h: number;

  constructor(size = desktopSize()) {
    this.w = size.w;
    this.h = size.h;
  }

  move(dx: number, dy: number) {
    // GNOME's pointer acceleration makes fast moves travel further than the raw counts; scaling up a
    // little gets closer on average, and the edges correct the rest.
    const gain = 1 + Math.min(1.5, Math.hypot(dx, dy) / 40);
    this.x = Math.max(0, Math.min(1, this.x + (dx * gain) / this.w));
    this.y = Math.max(0, Math.min(1, this.y + (dy * gain) / this.h));
    this.movedAt = performance.now();
  }
}
