// Drive the QK108's lock LEDs directly (the screen shows them as icons).
// Opens the boot-keyboard interface write-only, so it can't see keystrokes.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { HidDevice, findHidraw } from "./hidraw.ts";

export const Led = { Num: 1, Caps: 2, Scroll: 4, Compose: 8, Kana: 16 } as const;

/** Boot keyboard interface: descriptor starts with Usage Page (Generic Desktop), Usage (Keyboard). */
const BOOT_KEYBOARD = { vendorId: 0x36b0, productId: 0x30af, descriptorPrefix: Uint8Array.of(0x05, 0x01, 0x09, 0x06) };

export class Leds {
  private dev: HidDevice;

  constructor() {
    const path = findHidraw(BOOT_KEYBOARD);
    if (!path) throw new Error("QK108 boot keyboard interface not found");
    this.dev = new HidDevice(path, 1, { writeOnly: true });
  }

  /** Sets all 5 lock LEDs at once (bitmask of Led values). */
  set(bits: number) {
    this.dev.write(Uint8Array.of(bits & 0x1f));
  }

  /** Puts the LEDs back to what the kernel thinks they are. */
  restore() {
    this.set(hostLedState());
  }

  close() {
    this.dev.close();
  }
}

/** The lock-LED state Linux last sent to the QK108 (readable without root). */
export function hostLedState(): number {
  const names: Record<string, number> = { numlock: Led.Num, capslock: Led.Caps, scrolllock: Led.Scroll, compose: Led.Compose, kana: Led.Kana };
  let bits = 0;
  for (const n of readdirSync("/sys/class/leds")) {
    const [, kind] = n.split("::");
    if (!(kind in names)) continue;
    try {
      if (!realpathSync(`/sys/class/leds/${n}/device`).includes("36B0:30AF")) continue;
      if (readFileSync(`/sys/class/leds/${n}/brightness`, "utf8").trim() !== "0") bits |= names[kind];
    } catch {
      // LED vanished; ignore
    }
  }
  return bits;
}
