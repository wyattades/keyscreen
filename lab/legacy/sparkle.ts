// Keypress "sparkle": each key press briefly flips a random lock-LED icon on the screen.
import { onKeyDown } from "../../src/keys.ts";
import { Led, Leds, hostLedState } from "../../src/leds.ts";

export interface SparkleOptions {
  /** Which icons to use. Caps and Num are verified; the others are assumed to show. */
  icons?: number[];
  /** How long each flash lasts, ms. */
  flashMs?: number;
  log?: (msg: string) => void;
}

/** Starts the effect. Returns a function that stops it and restores the LEDs. */
export function startSparkle(opts: SparkleOptions = {}): () => void {
  const { icons = [Led.Num, Led.Caps, Led.Scroll, Led.Compose, Led.Kana], flashMs = 70, log = () => {} } = opts;
  const leds = new Leds();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let presses = 0;

  const restore = () => {
    timer = undefined;
    leds.restore();
  };

  const stopKeys = onKeyDown(
    () => {
      presses++;
      const icon = icons[Math.floor(Math.random() * icons.length)];
      // Flip the icon relative to the real state, so it visibly changes even if it's already on.
      leds.set(hostLedState() ^ icon);
      if (timer) clearTimeout(timer);
      timer = setTimeout(restore, flashMs);
    },
    (e) => log(`key events: ${e.message}`),
  );

  return () => {
    stopKeys();
    if (timer) clearTimeout(timer);
    leds.restore();
    leds.close();
    log(`sparkle stopped after ${presses} key presses`);
  };
}
