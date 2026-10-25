// The real mouse pointer position, from the keyscreen-pointer GNOME Shell extension
// (desktop/gnome-extension). Wayland doesn't let ordinary programs ask where the pointer is; the
// extension runs inside GNOME Shell, which knows, and shares it over D-Bus while we're watching.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DEST = ["--session", "--dest", "org.keyscreen.Pointer", "--object-path", "/org/keyscreen/Pointer"];

/** Pointer position (0-1 across the whole desktop) and desktop size. */
export interface PointerPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

const parse = (s: string): PointerPos | undefined => {
  const m = /\((-?\d+), (-?\d+), (\d+), (\d+)\)/.exec(s);
  if (!m) return undefined;
  const [x, y, w, h] = m.slice(1).map(Number);
  // The last pixel is the edge: x = w - 1 maps to 1.
  return {
    x: Math.max(0, Math.min(1, x / Math.max(1, w - 1))),
    y: Math.max(0, Math.min(1, y / Math.max(1, h - 1))),
    w,
    h,
  };
};

async function call(method: string): Promise<string | undefined> {
  try {
    return (await run("gdbus", ["call", ...DEST, "--method", `org.keyscreen.Pointer.${method}`], { timeout: 2000 }))
      .stdout;
  } catch {
    return undefined;
  }
}

/** Whether the extension is installed and enabled (it answers on D-Bus). */
export async function shellPointerAvailable(): Promise<boolean> {
  return (await call("Get")) !== undefined;
}

/**
 * Calls onMove with each new pointer position until the returned stop function is called.
 * Resolves to undefined if the extension isn't running.
 */
export async function watchShellPointer(onMove: (p: PointerPos) => void): Promise<(() => void) | undefined> {
  const first = await call("Get");
  if (first === undefined) return undefined;
  const p = parse(first);
  if (p) onMove(p);

  let stopped = false;
  // The extension only sends positions for 5 s after each Watch(), so keep asking.
  const keepalive = () => void call("Watch");
  keepalive();
  const timer = setInterval(keepalive, 2000);

  let monitor: ReturnType<typeof spawn> | undefined;
  const start = () => {
    if (stopped) return;
    // Line-buffered, or gdbus holds its output in a 4 KB buffer when writing into a pipe.
    monitor = spawn("stdbuf", ["-oL", "gdbus", "monitor", ...DEST], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    monitor.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.includes("Pointer.Moved")) continue;
        const pos = parse(line);
        if (pos) onMove(pos);
      }
    });
    monitor.on("exit", () => {
      if (!stopped) setTimeout(start, 2000);
    });
  };
  start();

  return () => {
    stopped = true;
    clearInterval(timer);
    monitor?.kill();
  };
}
