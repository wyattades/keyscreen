// Timed LED test. Watch the keyboard screen and note what each phase does.
// usage: node src/led-test.ts
import { sleep } from "../../src/hidraw.ts";
import { Led, Leds, hostLedState } from "../../src/leds.ts";

const t0 = performance.now();
const ts = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const say = (m: string) => console.log(`[${ts()}] ${m}`);

const leds = new Leds();
const before = hostLedState();
process.on("SIGINT", () => {
  leds.restore();
  process.exit(130);
});

try {
  say("all LEDs off");
  leds.set(0);
  await sleep(2000);

  // Phase 1: one bit at a time, 2 s on, 1 s off.
  for (const [name, bit] of Object.entries(Led)) {
    say(`${name} ON`);
    leds.set(bit);
    await sleep(2000);
    leds.set(0);
    await sleep(1000);
  }

  // Phase 2: blink Caps faster and faster, 3 s per rate.
  for (const hz of [2, 5, 10, 20, 50]) {
    const half = 1000 / hz / 2;
    say(`Caps blinking at ${hz} Hz`);
    const end = performance.now() + 3000;
    let on = false;
    let writes = 0;
    let next = performance.now();
    while (performance.now() < end) {
      on = !on;
      leds.set(on ? Led.Caps : 0);
      writes++;
      next += half;
      await sleep(Math.max(0, next - performance.now()));
    }
    leds.set(0);
    say(`  sent ${writes} writes`);
    await sleep(1500);
  }
} finally {
  leds.restore();
  say(`restored LEDs to host state (0b${before.toString(2).padStart(5, "0")})`);
  leds.close();
}
