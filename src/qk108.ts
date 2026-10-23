// Epomaker QK108 screen protocol. Spec: PROTOCOL.md. History of each detail: LOG.md.
import { HidDevice, findHidraw, sleep } from "./hidraw.ts";

/** Keyboard's VIA raw-HID interface (usage page 0xFF60), 32-byte reports. */
const KEYBOARD = { vendorId: 0x36b0, productId: 0x30af, descriptorPrefix: Uint8Array.of(0x06, 0x60, 0xff) };
/** Screen controller's vendor interface (usage page 0x00FF), 64-byte reports. */
const SCREEN = { vendorId: 0x1919, productId: 0x1919, descriptorPrefix: Uint8Array.of(0x06, 0xff, 0x00) };

export const Cmd = {
  Begin: 0x10,
  End: 0x11,
  ScreenInfo: 0x12,
  ReadTable: 0x14,
  WriteTable: 0x15,
  CommitTable: 0x16,
  SetTime: 0x17,
  GifErase: 0x18,
  GifWrite: 0x19,
  FinishDownload: 0x1a,
  StartDownload: 0x1b,
  Status: 0x1c,
} as const;

/** RGBA (4 bytes/pixel) -> big-endian RGB565, as the web tool encodes it. */
export function toRgb565(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 2);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 2) {
    const v = ((rgba[i] >> 3) << 11) | ((rgba[i + 1] >> 2) << 5) | (rgba[i + 2] >> 3);
    out[j] = v >> 8;
    out[j + 1] = v & 0xff;
  }
  return out;
}

export type Link = "bluetooth" | "2.4g" | "usb" | `unknown(${number})`;
const LINKS: Link[] = ["bluetooth", "2.4g", "usb"];

export interface ScreenInfo {
  width: number;
  height: number;
  rotate: number;
}

type Log = (msg: string) => void;

export type SwitchMode = "flip" | "func" | "minimal" | "full";

/** One slot-table entry: where an image starts (64 KiB block index) and its byte length. */
export interface SlotEntry {
  start: number;
  length: number;
}

/** 64-byte screen packet: AA cmd addr(3, LE) len 00 00 payload. */
export function packet(cmd: number, payload: ArrayLike<number> = [], length = 0, addr = 0): Uint8Array {
  const p = new Uint8Array(64);
  p.set([0xaa, cmd, addr & 0xff, (addr >> 8) & 0xff, (addr >> 16) & 0xff, length]);
  p.set(Array.from(payload).slice(0, 56), 8);
  return p;
}

/** One decimal digit per byte: YYYY MM dow DD hh mm ss, Sunday = 0. */
export function timeDigits(t = new Date()): number[] {
  const two = (n: number) => [Math.floor(n / 10) % 10, n % 10];
  const y = t.getFullYear();
  return [
    Math.floor(y / 1000) % 10, Math.floor(y / 100) % 10, Math.floor(y / 10) % 10, y % 10,
    ...two(t.getMonth() + 1),
    t.getDay(),
    ...two(t.getDate()),
    ...two(t.getHours()),
    ...two(t.getMinutes()),
    ...two(t.getSeconds()),
  ];
}

export class Keyboard {
  private dev: HidDevice;

  constructor() {
    const path = findHidraw(KEYBOARD);
    if (!path) throw new Error("QK108 keyboard (36b0:30af) not found, or no permission. Is it plugged in by USB?");
    this.dev = new HidDevice(path, 32);
  }

  close() {
    this.dev.close();
  }

  private async send(cmd: number, payload: number[] = []): Promise<Uint8Array> {
    this.dev.drain();
    const p = new Uint8Array(32);
    p.set([0xaa, cmd, 0, 0, 0, payload.length]);
    p.set(payload, 8);
    this.dev.write(p);
    return this.dev.readUntil((r) => r[0] === 0xaa && r[1] === cmd, 1000);
  }

  /** AA E3: tells the keyboard how many screens (GIFs + images) are stored. Sent before an upload. */
  async setScreenCount(n: number): Promise<void> {
    await this.send(0xe3, [n]);
  }

  /** AA E2: reply byte 8 == 1 means screen mode is on. */
  async screenModeOn(): Promise<boolean> {
    return (await this.send(0xe2))[8] === 1;
  }

  /** AA E0: asks the keyboard to power up the screen controller (1919:1919). */
  async openScreenMode(): Promise<void> {
    await this.send(0xe0);
  }
}

export class Screen {
  private dev: HidDevice;

  private constructor(dev: HidDevice) {
    this.dev = dev;
  }

  get path() {
    return this.dev.path;
  }

  /**
   * Opens the screen controller. It only appears on USB after the keyboard
   * gets AA E0, and drops off ~4 s later unless a host keeps talking to it,
   * so this sends E0 every 400 ms (like the official tool) until it shows up.
   */
  static async connect(timeoutMs = 15000, log: Log = () => {}): Promise<Screen> {
    const end = Date.now() + timeoutMs;
    let kb: Keyboard | undefined;
    try {
      while (Date.now() < end) {
        const path = findHidraw(SCREEN);
        if (path) {
          try {
            const s = new Screen(new HidDevice(path, 64));
            s.dev.drain();
            return s;
          } catch (e) {
            log(`open ${path} failed: ${(e as Error).message}`);
          }
        } else {
          kb ??= new Keyboard();
          await kb.openScreenMode();
          log("sent AA E0 to keyboard, waiting for screen…");
        }
        await sleep(400);
      }
    } finally {
      kb?.close();
    }
    throw new Error("screen controller (1919:1919) did not appear. Is the keyboard on USB (not BT/2.4G)?");
  }

  close() {
    this.dev.close();
  }

  /** Sends one packet and waits for the reply that echoes AA cmd. */
  async send(pkt: Uint8Array, timeoutMs = 1000): Promise<Uint8Array> {
    const name = `0x${pkt[1].toString(16)}${pkt[2] ? `@${pkt[2].toString(16)}` : ""}`;
    let r: Uint8Array;
    try {
      this.dev.write(pkt);
      r = await this.dev.readUntil((r) => r[0] === 0xaa && r[1] === pkt[1], timeoutMs);
    } catch (e) {
      throw new Error(`screen command ${name}: ${(e as Error).message}`);
    }
    if (r[7] === 0x0f) throw new Error(`screen rejected command ${name}`);
    return r;
  }

  async syncTime(t = new Date()): Promise<void> {
    await this.send(packet(Cmd.Begin));
    await this.send(packet(Cmd.SetTime, timeDigits(t), 0x38));
    await this.send(packet(Cmd.End));
  }

  async info(): Promise<ScreenInfo> {
    await this.send(packet(Cmd.Begin));
    const r = await this.send(packet(Cmd.ScreenInfo, [], 0x38));
    await this.send(packet(Cmd.End));
    const u16 = (i: number) => r[i] | (r[i + 1] << 8);
    const rotate = r[26];
    const [w, h] = [u16(20), u16(22)];
    return rotate === 1 || rotate === 3 ? { width: h, height: w, rotate } : { width: w, height: h, rotate };
  }

  /** AA 14: reads the slot table (raw reply). Read-only; the web tool sends it before GIF uploads. */
  async readTable(): Promise<Uint8Array> {
    return this.send(packet(Cmd.ReadTable, [], 0x38));
  }

  /**
   * Replaces ALL stored screens with these QGIF payloads, the way the web tool's GIF
   * session does it. Each GIF starts on a 64 KiB block boundary. Returns phase timings in ms.
   */
  async uploadGifs(
    gifs: Uint8Array[],
    opts: {
      onProgress?: (sent: number, total: number) => void;
      slots?: number;
      spareBlocks?: number;
      /** Erased blocks left empty at the START of flash (0..n-1), before the images. */
      leadingBlocks?: number;
    } = {},
  ) {
    // `slots`: how many table entries to create (the first images). Extra images are stored but
    // only reachable by re-pointing a slot with switchTable(). The table holds at most 10 entries.
    const slotCount = opts.slots ?? gifs.length;
    if (!gifs.length || slotCount < 1 || slotCount > 10 || slotCount > gifs.length) throw new Error("need 1-10 visible slots and at least that many images");
    const leading = opts.leadingBlocks ?? 0;
    const starts: number[] = [];
    let blocks = leading;
    for (const g of gifs) {
      starts.push(blocks);
      blocks += Math.ceil(g.length / 65536);
    }
    const total = gifs.reduce((s, g) => s + g.length, 0);
    const ms: Record<string, number> = {};
    let mark = performance.now();
    const lap = (name: string) => {
      const now = performance.now();
      ms[name] = Math.round(now - mark);
      mark = now;
    };

    const kb = new Keyboard();
    try {
      await kb.setScreenCount(slotCount);
    } finally {
      kb.close();
    }
    await this.send(packet(Cmd.StartDownload, [], 0x38));
    await this.send(packet(Cmd.ReadTable, [], 0x38));
    lap("setup");

    const entries = gifs.map((g, i) => ({ start: starts[i], length: g.length }));
    // Spare blocks: allocated and erased now, left empty, so images can be written into them later
    // with writeImage() without another erase.
    const spare = opts.spareBlocks ?? 0;
    const allocated = blocks + spare;
    await this.writeTable(entries.slice(0, slotCount), allocated);
    lap("table");

    // The erase reply can arrive only after the erase itself, so allow ~1 s per block.
    await this.send(packet(Cmd.GifErase, [allocated], 1), 2000 + 1000 * allocated);
    await sleep(500 * allocated);
    lap("erase");

    let sent = 0;
    for (let i = 0; i < gifs.length; i++) {
      const g = gifs[i], base = starts[i] * 65536;
      for (let off = 0; off < g.length; off += 56) {
        const chunk = g.subarray(off, off + 56);
        await this.send(packet(Cmd.GifWrite, chunk, chunk.length, base + off));
        sent += chunk.length;
        if ((off / 56) % 32 === 0) opts.onProgress?.(sent, total);
      }
    }
    opts.onProgress?.(total, total);
    lap("write");

    await sleep(500);
    await this.send(packet(Cmd.FinishDownload));
    await this.syncTime();
    await this.send(packet(Cmd.End));
    lap("finish");
    return { blocks: allocated, firstSpare: blocks, leadingBlocks: leading, bytes: total, packets: Math.ceil(total / 56), ms, entries };
  }

  /** Slot table: 00 count totalBlocks, then per slot: startBlock 00 lenL lenM lenH. Sent as 3 pages + commit. */
  /** `headerStart`: the table's first byte, always 0 in every known tool (meaning unknown). */
  private async writeTable(slots: SlotEntry[], totalBlocks: number, headerStart = 0) {
    const table = [headerStart, slots.length, totalBlocks];
    for (const s of slots) table.push(s.start, 0, s.length & 0xff, (s.length >> 8) & 0xff, (s.length >> 16) & 0xff);
    await this.send(packet(Cmd.WriteTable, table, 0x38));
    await this.send(packet(Cmd.WriteTable, [], 0x38, 0x38));
    await this.send(packet(Cmd.WriteTable, [], 0x10, 0x70));
    await this.send(packet(Cmd.CommitTable, [], 0x38));
  }

  /**
   * Points the slots at already-stored images without erasing or writing image data.
   * "minimal" skips the keyboard count, table read and time sync that "full" (the RT82 sequence) sends.
   * Both go through download mode (1B) and LCD re-init (1A); "func" uses only the 10/11 FUNC session
   * (table changes but the screen doesn't redraw); "flip" is func + 1A, which redraws without download mode.
   * Returns elapsed ms.
   */
  async switchTable(slots: SlotEntry[], totalBlocks: number, mode: SwitchMode = "minimal"): Promise<number> {
    const t0 = performance.now();
    if (mode === "func" || mode === "flip") {
      // FUNC_START / WRITE_FUNC x3 / WRITE_FUNC_OK / FUNC_STOP: no download mode (1B).
      await this.send(packet(Cmd.Begin));
      await this.writeTable(slots, totalBlocks);
      await this.send(packet(Cmd.End));
      // The table change only shows after INIT_LCD (1A); "func" alone updates the table silently.
      if (mode === "flip") await this.send(packet(Cmd.FinishDownload));
      return performance.now() - t0;
    }
    if (mode === "full") {
      const kb = new Keyboard();
      try {
        await kb.setScreenCount(slots.length);
      } finally {
        kb.close();
      }
    }
    await this.send(packet(Cmd.StartDownload, [], 0x38));
    if (mode === "full") await this.send(packet(Cmd.ReadTable, [], 0x38));
    await this.writeTable(slots, totalBlocks);
    await this.send(packet(Cmd.FinishDownload));
    if (mode === "full") await this.syncTime();
    await this.send(packet(Cmd.End));
    return performance.now() - t0;
  }

  /**
   * Writes an image into an already-erased flash block (no erase). `session` picks what wraps the
   * FLASH_WRITE (19) packets: none, the plain 10/11 FUNC session, or a download session (1B ... 1A, 11).
   * Returns elapsed ms. Flash can only be written once after an erase, so never reuse a block.
   */
  /**
   * FLASH_WRITE (19) of `data` at a byte address, in 56-byte packets, no session. The target bytes
   * must already be erased (flash bits only go 1 -> 0). Returns elapsed ms.
   */
  async writeAt(address: number, data: Uint8Array, window = this.writeWindow): Promise<number> {
    const t0 = performance.now();
    if (window <= 1) {
      for (let off = 0; off < data.length; off += 56) {
        const chunk = data.subarray(off, off + 56);
        await this.send(packet(Cmd.GifWrite, chunk, chunk.length, address + off));
      }
      return performance.now() - t0;
    }
    // Pipelined: keep up to `window` FLASH_WRITE packets in flight, then match replies in order.
    const offsets: number[] = [];
    for (let off = 0; off < data.length; off += 56) offsets.push(off);
    let sent = 0, acked = 0;
    while (acked < offsets.length) {
      while (sent < offsets.length && sent - acked < window) {
        const off = offsets[sent++];
        const chunk = data.subarray(off, off + 56);
        this.dev.write(packet(Cmd.GifWrite, chunk, chunk.length, address + off));
      }
      let r: Uint8Array;
      try {
        r = await this.dev.readUntil((r) => r[0] === 0xaa && r[1] === Cmd.GifWrite, 1000);
      } catch (e) {
        throw new Error(`pipelined write (window ${window}) at packet ${acked}/${offsets.length}: ${(e as Error).message}`);
      }
      if (r[7] === 0x0f) throw new Error(`screen rejected pipelined write at packet ${acked}`);
      acked++;
    }
    return performance.now() - t0;
  }

  /** Default number of FLASH_WRITE packets kept in flight by writeAt (1 = wait for each reply). */
  writeWindow = 1;

  async writeImage(block: number, data: Uint8Array, session: "bare" | "func" | "download" = "bare"): Promise<number> {
    const t0 = performance.now();
    if (session === "func") await this.send(packet(Cmd.Begin));
    if (session === "download") await this.send(packet(Cmd.StartDownload, [], 0x38));
    const base = block * 65536;
    for (let off = 0; off < data.length; off += 56) {
      const chunk = data.subarray(off, off + 56);
      await this.send(packet(Cmd.GifWrite, chunk, chunk.length, base + off));
    }
    if (session === "func") await this.send(packet(Cmd.End));
    if (session === "download") {
      await this.send(packet(Cmd.FinishDownload));
      await this.send(packet(Cmd.End));
    }
    return performance.now() - t0;
  }

  /**
   * FLASH_ERASE (18) of the first `count` blocks (0..count-1) with no download session.
   * Returns the reply and how long it took to arrive (ms).
   */
  async eraseFirstBlocks(count: number): Promise<{ ms: number; reply: Uint8Array }> {
    const t0 = performance.now();
    const reply = await this.send(packet(Cmd.GifErase, [count], 1), 2000 + 1000 * count);
    return { ms: performance.now() - t0, reply };
  }

  /**
   * Erases the first `count` blocks inside a short download session (the screen shows "Downloading"
   * for its duration). The erase wipes whatever the slot table says is ALLOCATED, not the count it is
   * sent, so the table is written with an allocation of `count` for the erase, then `slots` are put
   * back with the real `totalBlocks` and the display redrawn. Returns ms per phase.
   */
  async quickErase(count: number, slots: SlotEntry[], totalBlocks: number, settleMs = 0) {
    const ms: Record<string, number> = {};
    let mark = performance.now();
    const t0 = mark;
    const lap = (name: string) => {
      const now = performance.now();
      ms[name] = Math.round(now - mark);
      mark = now;
    };
    await this.send(packet(Cmd.StartDownload, [], 0x38));
    await this.send(packet(Cmd.ReadTable, [], 0x38));
    // Keep slot entries inside the erased range only (block 0) so nothing points past the allocation.
    await this.writeTable([{ start: 0, length: slots[0]?.length ?? 0 }], count);
    lap("setup");
    await this.send(packet(Cmd.GifErase, [count], 1), 2000 + 1000 * count);
    lap("eraseReply");
    if (settleMs) await sleep(settleMs);
    lap("settle");
    await this.send(packet(Cmd.FinishDownload));
    await this.send(packet(Cmd.End));
    lap("download");
    await this.switchTable(slots, totalBlocks, "flip");
    lap("restore");
    ms.total = Math.round(performance.now() - t0);
    return ms;
  }

  /**
   * Erases flash inside the plain FUNC session (10 ... 11): no download mode, no "Downloading" screen,
   * no display redraw. The erase follows the slot table's allocation, so the table is first written with
   * `allocation` blocks (default `count`), then `restore` slots/`totalBlocks` are put back without a
   * redraw. `start` is sent as the erase's start block (bytes 2-3, as Epomaker Hub does); 0 = from the
   * beginning, which is verified. Nonzero starts are experimental.
   */
  async funcErase(
    count: number,
    restore: SlotEntry[],
    totalBlocks: number,
    opts: { start?: number; allocation?: number; headerStart?: number } = {},
  ) {
    const { start = 0, allocation = count, headerStart = 0 } = opts;
    const t0 = performance.now();
    await this.send(packet(Cmd.Begin));
    await this.writeTable([{ start, length: restore[0]?.length ?? 0 }], allocation, headerStart);
    const tErase = performance.now();
    const reply = await this.send(packet(Cmd.GifErase, [count], 1, start), 4000 + 500 * count);
    const eraseMs = performance.now() - tErase;
    await this.send(packet(Cmd.End));
    await this.switchTable(restore, totalBlocks, "func");
    return { eraseMs: Math.round(eraseMs), totalMs: Math.round(performance.now() - t0), reply };
  }

  /** Closes an upload session after an error, like the web tool does. */
  async abortUpload() {
    await this.send(packet(Cmd.FinishDownload));
    await this.syncTime();
    await this.send(packet(Cmd.End));
  }

  /** EXPERIMENT: sends a read-style command (e.g. 14 READ_FUNC, 12 READ_INFO) at an address; returns the raw reply. */
  async readAt(cmd: number, address: number, length = 0x38): Promise<Uint8Array> {
    return this.send(packet(cmd, [], length, address), 2000);
  }

  /** AA 1C: connection status. Doubles as the keepalive. */
  async status(): Promise<Link> {
    const v = (await this.send(packet(Cmd.Status)))[9];
    return LINKS[v] ?? `unknown(${v})`;
  }
}

/**
 * Keeps the screen connected: syncs the time on every (re)connect and pings
 * every 3 s. Runs until the signal aborts.
 */
export async function keepalive(opts: { signal?: AbortSignal; log?: Log; intervalMs?: number } = {}) {
  const { signal, log = console.log, intervalMs = 3000 } = opts;
  while (!signal?.aborted) {
    let screen: Screen | undefined;
    try {
      screen = await Screen.connect(15000, log);
      log(`connected ${screen.path}`);
      await screen.syncTime();
      log(`time synced to ${new Date().toLocaleString()}`);
      while (!signal?.aborted) {
        const link = await screen.status();
        if (link !== "usb") log(`warning: screen reports link=${link}`);
        await sleep(intervalMs);
      }
    } catch (e) {
      log(`screen lost: ${(e as Error).message}; reconnecting`);
      await sleep(500);
    } finally {
      screen?.close();
    }
  }
}
