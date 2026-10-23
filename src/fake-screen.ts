// A stand-in for the real screen (FAKE_SCREEN=1): same timings as measured on the QK108
// (~1 ms per 56-byte write packet, 140 ms switches, ~120 ms per erased block), no USB.
// Lets the screen server and its page be tried without touching the keyboard.
import { sleep } from "./hidraw.ts";
import type { Layout } from "./layout.ts";
import { MANAGED_BLOCKS } from "./layout.ts";
import type { Screen } from "./qk108.ts";

export function fakeScreen(): Screen {
  const fake = {
    path: "(fake screen)",
    writeWindow: 1,
    async writeAt(_addr: number, data: Uint8Array) {
      await sleep(Math.ceil(data.length / 56) * 1.05);
      return 0;
    },
    async switchTable() {
      await sleep(140);
      return 140;
    },
    async funcErase(n: number) {
      await sleep(120 * n);
      return { eraseMs: 120 * n, totalMs: 120 * n, reply: new Uint8Array(64) };
    },
    async status() {
      return "usb";
    },
    close() {},
  };
  return fake as unknown as Screen;
}

export const fakeLayout: Layout = {
  total: MANAGED_BLOCKS + 3,
  managed: MANAGED_BLOCKS,
  frames: {
    WAIT: { start: MANAGED_BLOCKS, length: 16840 },
    DONE: { start: MANAGED_BLOCKS + 1, length: 16840 },
    BLANK: { start: MANAGED_BLOCKS + 2, length: 16840 },
  },
};
