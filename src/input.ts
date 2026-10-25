// The computer's keyboard and mouse, for the modes that react to them (key ticker, sand).
// One place that knows where input comes from, so modes don't:
//
//   keys, mouse buttons, wheel, raw movement   evdev (/dev/input), Linux. Access comes from the udev
//                                              rule (70-keyscreen.rules), not the `input` group.
//   pointer position                          the keyscreen-pointer GNOME Shell extension when it's
//                                              running (exact); otherwise estimated from raw movement,
//                                              which drifts with pointer acceleration near the edges.
//
// Other platforms (macOS, Windows, X11) would add a backend here; nothing outside this file changes.
import { onTypedChar } from "./keys.ts";
import { BTN_LEFT, BTN_RIGHT, onMouse, PointerTracker } from "./mouse.ts";
import { watchShellPointer } from "./pointer.ts";

export type Button = "left" | "right" | "middle";

export interface InputHandlers {
  /** A typed character (shift-aware, uppercase), "\b" for Backspace, "\n" for Enter. */
  key?: (ch: string) => void;
  button?: (b: Button) => void;
  wheel?: (steps: number) => void;
  /** The pointer moved; read the position from `input.pointer`. */
  pointerMoved?: () => void;
}

export interface Input {
  /** Pointer position, 0-1 across the whole desktop. */
  pointer: { x: number; y: number };
  /** Where things come from right now ("none" = not available, e.g. no permission). */
  source: { keys: "evdev" | "none"; mouse: "evdev" | "none"; pointer: "gnome" | "estimate" | "none" };
  /** Why something is "none", if it is. */
  problem: string;
  stop(): void;
}

/** How often to try again to open devices that couldn't be opened (e.g. right at login, before the
 * session is active and the udev rule has granted access, or while the keyboard is unplugged). */
const RETRY_MS = 3000;

/**
 * Starts listening. Never throws: whatever isn't available shows up in `source` and `problem`, and
 * is retried every RETRY_MS until it works or stop() is called.
 */
export function watchInput(h: InputHandlers): Input {
  const stops: (() => void)[] = [];
  const tracker = new PointerTracker();
  let stopped = false;
  const input: Input = {
    pointer: tracker,
    source: { keys: "none", mouse: "none", pointer: "none" },
    problem: "",
    stop() {
      stopped = true;
      for (const s of stops) s();
    },
  };

  const problems: Record<string, string> = {};
  const updateProblem = () => (input.problem = Object.values(problems).join("; "));

  const openKeys = () => {
    try {
      stops.push(onTypedChar(h.key!));
      input.source.keys = "evdev";
      delete problems.keys;
    } catch (e) {
      problems.keys = `keys: ${(e as Error).message}`;
    }
  };
  const openMouse = () => {
    try {
      stops.push(
        onMouse({
          move: (dx, dy) => {
            if (input.source.pointer !== "estimate") return;
            tracker.move(dx, dy);
            h.pointerMoved?.();
          },
          button: (b, down) => down && h.button?.(b === BTN_LEFT ? "left" : b === BTN_RIGHT ? "right" : "middle"),
          wheel: (n) => h.wheel?.(n),
        }),
      );
      input.source.mouse = "evdev";
      if (input.source.pointer === "none") input.source.pointer = "estimate";
      delete problems.mouse;
    } catch (e) {
      problems.mouse = `mouse: ${(e as Error).message}`;
    }
  };
  const wantMouse = !!(h.button || h.wheel || h.pointerMoved);
  if (h.key) openKeys();
  if (wantMouse) openMouse();
  updateProblem();
  // Retry whatever didn't open.
  const retry = setInterval(() => {
    if (h.key && input.source.keys === "none") openKeys();
    if (wantMouse && input.source.mouse === "none") openMouse();
    updateProblem();
  }, RETRY_MS);
  stops.push(() => clearInterval(retry));

  // The exact pointer from GNOME, if the extension is running; it takes over from the estimate.
  // GNOME may not be up yet right after login, so keep looking.
  if (h.pointerMoved) {
    const tryGnome = () => {
      let first = true;
      void watchShellPointer((p) => {
        tracker.x = p.x;
        tracker.y = p.y;
        // The first report is just where it is now, not a movement.
        if (!first) h.pointerMoved?.();
        first = false;
      }).then((stop) => {
        if (stopped) return stop?.();
        if (!stop) return void setTimeout(tryGnome, RETRY_MS * 3);
        stops.push(stop);
        input.source.pointer = "gnome";
      });
    };
    tryGnome();
  }

  return input;
}
