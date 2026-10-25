// Watches whether the computer's screen is locked or blanked (GNOME), so the keyboard screen can
// sleep too. Two sources, either one counts:
//   - org.gnome.ScreenSaver: the ActiveChanged signal (through `gdbus monitor`) and GetActive
//   - logind's LockedHint for this session (set by GNOME's lock screen)
// Both are also re-checked every POLL_MS in case a signal is missed or the monitor dies.
// `gdbus monitor` is run through `stdbuf -oL`: writing into a pipe, it would otherwise hold its
// output in a 4 KB buffer and the signal would arrive minutes late (or never).
import { spawn, spawnSync } from "node:child_process";

const DEST = ["--session", "--dest", "org.gnome.ScreenSaver", "--object-path", "/org/gnome/ScreenSaver"];
const POLL_MS = 3_000;

/** GNOME's screen shield: true = locked/blanked, undefined = can't tell. */
function gnomeActive(): boolean | undefined {
  const r = spawnSync("gdbus", ["call", ...DEST, "--method", "org.gnome.ScreenSaver.GetActive"], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (r.status !== 0) return undefined;
  return r.stdout.includes("true") ? true : r.stdout.includes("false") ? false : undefined;
}

let sessionId: string | undefined;

/** logind's LockedHint for the user's graphical session, undefined = can't tell. */
function logindLocked(): boolean | undefined {
  sessionId ||= spawnSync("loginctl", ["show-user", String(process.getuid?.() ?? ""), "-p", "Display", "--value"], {
    encoding: "utf8",
    timeout: 2000,
  }).stdout?.trim();
  if (!sessionId) return undefined;
  const r = spawnSync("loginctl", ["show-session", sessionId, "-p", "LockedHint", "--value"], {
    encoding: "utf8",
    timeout: 2000,
  });
  const v = r.stdout?.trim();
  return v === "yes" ? true : v === "no" ? false : undefined;
}

/** true = locked/blanked, false = in use, undefined = can't tell (no session bus or logind). */
export function screenLocked(): boolean | undefined {
  const a = gnomeActive(),
    b = logindLocked();
  if (a === undefined && b === undefined) return undefined;
  return a === true || b === true;
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
    monitor = spawn("stdbuf", ["-oL", "gdbus", "monitor", ...DEST], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    monitor.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        const m = /ActiveChanged \((true|false),\)/.exec(line);
        // The signal can arrive before logind's flag flips, so trust it directly for locking, and
        // re-check both sources for unlocking.
        if (m) set(m[1] === "true" ? true : screenLocked());
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
