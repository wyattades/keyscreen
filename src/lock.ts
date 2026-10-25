// Watches whether the computer's screen is locked or blanked (GNOME), so the keyboard screen can
// sleep too. Listens to org.gnome.ScreenSaver's ActiveChanged signal through `gdbus monitor`, and
// also asks GetActive every POLL_MS in case a signal is missed or the monitor dies.
import { spawn, spawnSync } from "node:child_process";

const DEST = ["--session", "--dest", "org.gnome.ScreenSaver", "--object-path", "/org/gnome/ScreenSaver"];
const POLL_MS = 15_000;

/** true = locked/blanked, false = in use, undefined = can't tell (no GNOME session bus). */
export function screenLocked(): boolean | undefined {
  const r = spawnSync("gdbus", ["call", ...DEST, "--method", "org.gnome.ScreenSaver.GetActive"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (r.status !== 0) return undefined;
  return r.stdout.includes("true") ? true : r.stdout.includes("false") ? false : undefined;
}

/** Calls onChange(locked) now and whenever it changes. Returns a function that stops watching. */
export function watchScreenLock(onChange: (locked: boolean) => void, log: (m: string) => void = () => {}) {
  let current: boolean | undefined;
  let stopped = false;
  const set = (locked: boolean | undefined) => {
    if (locked === undefined || locked === current) return;
    current = locked;
    onChange(locked);
  };

  const first = screenLocked();
  if (first === undefined)
    log("can't read the screen-lock state (no GNOME session bus?); sleep mode only works by hand");
  set(first);

  let monitor: ReturnType<typeof spawn> | undefined;
  const startMonitor = () => {
    if (stopped) return;
    monitor = spawn("gdbus", ["monitor", ...DEST], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    monitor.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        const m = /ActiveChanged \((true|false),\)/.exec(line);
        if (m) set(m[1] === "true");
      }
    });
    monitor.on("exit", () => {
      if (!stopped) setTimeout(startMonitor, 5000);
    });
  };
  startMonitor();
  const poll = setInterval(() => set(screenLocked()), POLL_MS);

  return () => {
    stopped = true;
    clearInterval(poll);
    monitor?.kill();
  };
}
