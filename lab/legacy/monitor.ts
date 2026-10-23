// Read-only monitor: logs the host's lock-LED state for the QK108 alongside any
// unprompted reports from the screen (1919:1919) and the keyboard's vendor channel.
// Sends only the AA 1C keepalive (and AA E0 if the screen needs waking).
// usage: node src/monitor.ts [seconds]
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { HidDevice, findHidraw, sleep } from "../../src/hidraw.ts";
import { Screen, packet } from "../../src/qk108.ts";

const seconds = Number(process.argv[2] ?? 40);
const t0 = performance.now();
const ts = () => `+${((performance.now() - t0) / 1000).toFixed(3)}s`;
const hex = (b: Uint8Array, n = 24) => Buffer.from(b.subarray(0, n)).toString("hex").replace(/(..)/g, "$1 ").trim();

// Lock LEDs the kernel exposes for the QK108's input devices.
const leds = readdirSync("/sys/class/leds")
  .filter((n) => /::(capslock|numlock|scrolllock)$/.test(n))
  .filter((n) => {
    try {
      return realpathSync(`/sys/class/leds/${n}/device`).includes("36B0:30AF");
    } catch {
      return false;
    }
  });
const ledState = () => Object.fromEntries(leds.map((n) => [n, readFileSync(`/sys/class/leds/${n}/brightness`, "utf8").trim()]));

const screen = await Screen.connect(15000, (m) => console.log(ts(), m));
const lcd = new HidDevice(screen.path, 64); // second read-only handle on the screen channel
const kbPath = findHidraw({ vendorId: 0x36b0, productId: 0x30af, descriptorPrefix: Uint8Array.of(0x06, 0x60, 0xff) });
const kb = kbPath ? new HidDevice(kbPath, 32) : undefined;

console.log(ts(), `watching ${leds.length} LEDs, screen ${screen.path}, keyboard ${kbPath} for ${seconds}s`);
console.log(ts(), ">>> toggle Caps Lock a few times now <<<");

let prev = JSON.stringify(ledState());
let lastPing = 0;
let pings = 0;
const end = performance.now() + seconds * 1000;
try {
  while (performance.now() < end) {
    const now = JSON.stringify(ledState());
    if (now !== prev) {
      const short = Object.entries(JSON.parse(now)).map(([k, v]) => `${k.split("::")[1]}=${v}`);
      console.log(ts(), "host LED change:", [...new Set(short)].join(" "));
      prev = now;
    }
    for (let r; (r = lcd.tryRead()); ) {
      if (r[0] === 0xaa && r[1] === 0x1c) continue; // our own keepalive replies
      console.log(ts(), "SCREEN report:", hex(r));
    }
    for (let r; kb && (r = kb.tryRead()); ) console.log(ts(), "KEYBOARD report:", hex(r));
    if (performance.now() - lastPing > 3000) {
      lastPing = performance.now();
      await screen.send(packet(0x1c));
      pings++;
    }
    await sleep(5);
  }
} finally {
  lcd.close();
  kb?.close();
  screen.close();
}
console.log(ts(), `done (${pings} keepalive pings sent)`);
