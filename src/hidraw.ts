// Minimal Linux hidraw access: find a node by USB IDs + report descriptor, then
// write reports and read replies. No native modules.
import { closeSync, constants, openSync, readFileSync, readSync, readdirSync, writeSync } from "node:fs";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface HidMatch {
  vendorId: number;
  productId: number;
  /** First bytes of the report descriptor, used to pick the right interface. */
  descriptorPrefix: Uint8Array;
}

/** Returns /dev/hidrawN for the first interface that matches, or undefined. */
export function findHidraw(m: HidMatch): string | undefined {
  const hidId = `HID_ID=0003:${hex8(m.vendorId)}:${hex8(m.productId)}`;
  let names: string[];
  try {
    names = readdirSync("/sys/class/hidraw").sort();
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const base = `/sys/class/hidraw/${name}/device`;
      if (!readFileSync(`${base}/uevent`, "utf8").includes(hidId)) continue;
      const desc = readFileSync(`${base}/report_descriptor`);
      if (m.descriptorPrefix.every((b, i) => desc[i] === b)) return `/dev/${name}`;
    } catch {
      // device vanished while we looked; keep going
    }
  }
  return undefined;
}

const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");

/**
 * One open hidraw node. Reads are non-blocking and polled, so closing never
 * leaves a stuck read behind when the device disappears.
 */
export class HidDevice {
  readonly path: string;
  readonly reportSize: number;
  private fd: number | undefined;

  constructor(path: string, reportSize: number, opts: { writeOnly?: boolean } = {}) {
    this.path = path;
    this.reportSize = reportSize;
    const access = opts.writeOnly ? constants.O_WRONLY : constants.O_RDWR;
    this.fd = openSync(path, access | constants.O_NONBLOCK);
  }

  get isOpen() {
    return this.fd !== undefined;
  }

  close() {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  /** Writes one report. Pads to reportSize and prepends report ID 0. */
  write(data: Uint8Array) {
    const buf = new Uint8Array(this.reportSize + 1);
    buf.set(data.subarray(0, this.reportSize), 1);
    writeSync(this.requireFd(), buf);
  }

  /** Returns the next pending report, or undefined if none is waiting. */
  tryRead(): Uint8Array | undefined {
    const buf = new Uint8Array(this.reportSize);
    try {
      const n = readSync(this.requireFd(), buf);
      return buf.subarray(0, n);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") return undefined;
      throw e;
    }
  }

  /** Drops any reports already waiting. */
  drain() {
    while (this.tryRead());
  }

  /** Waits for a report that satisfies `match`, ignoring others. */
  async readUntil(match: (r: Uint8Array) => boolean, timeoutMs: number): Promise<Uint8Array> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const r = this.tryRead();
      if (r) {
        if (match(r)) return r;
        continue;
      }
      await sleep(2);
    }
    throw new Error(`${this.path}: timed out waiting for reply`);
  }

  private requireFd() {
    if (this.fd === undefined) throw new Error(`${this.path} is closed`);
    return this.fd;
  }
}
