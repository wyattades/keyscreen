// The screen's flash layout, shared by the screen service and the dashboard tests:
//   blocks 0 .. MANAGED_BLOCKS-1 : erased space for live streams + parking (erase can only clear from 0)
//   then permanent one-frame images: WAIT, DONE, BLANK
// Setting it up is a full upload (the screen shows "Downloading" for ~10-15 s); after that it's reused.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Screen, SlotEntry } from "./qk108.ts";
import { encodeQgif } from "./qgif.ts";
import { bigText } from "./textframe.ts";

export const MANAGED_BLOCKS = 48;
export const PERMANENT_FRAMES = ["WAIT", "DONE", "BLANK"] as const;
export type PermanentFrame = (typeof PERMANENT_FRAMES)[number];
export const LAYOUT_FILE = "state/layout.json";

export interface Layout {
  /** Blocks allocated in the slot table (managed area + permanent frames). */
  total: number;
  /** Blocks 0..managed-1 are free for streams and parking. */
  managed: number;
  frames: Record<PermanentFrame, SlotEntry>;
}

export function loadLayout(): Layout | undefined {
  if (!existsSync(LAYOUT_FILE)) return undefined;
  const l = JSON.parse(readFileSync(LAYOUT_FILE, "utf8")) as Layout;
  return l.managed === MANAGED_BLOCKS && PERMANENT_FRAMES.every((f) => l.frames[f]) ? l : undefined;
}

function frameFor(name: PermanentFrame) {
  return encodeQgif([{ rgba: bigText(name === "BLANK" ? "" : name) }], { width: 240, height: 136, fps: 1 });
}

/**
 * Returns the layout, uploading it first if this keyboard doesn't have it (or `force`).
 * Detection: our saved layout plus a slot table with 1 slot and the same allocation.
 */
export async function ensureLayout(s: Screen, log: (m: string) => void = () => {}, force = false): Promise<Layout> {
  const saved = loadLayout();
  if (saved && !force) {
    const t = await s.readTable();
    if (t[9] === 1 && t[10] === saved.total) return saved;
    log("the screen's flash doesn't match the saved layout; setting it up again");
  }
  log(
    `setting up flash: ${MANAGED_BLOCKS} free blocks + ${PERMANENT_FRAMES.join(", ")} (the screen shows Downloading)…`,
  );
  const up = await s.uploadGifs(PERMANENT_FRAMES.map(frameFor), { slots: 1, leadingBlocks: MANAGED_BLOCKS });
  const layout: Layout = {
    total: up.blocks,
    managed: MANAGED_BLOCKS,
    frames: Object.fromEntries(PERMANENT_FRAMES.map((n, i) => [n, up.entries[i]])) as Record<PermanentFrame, SlotEntry>,
  };
  mkdirSync("state", { recursive: true });
  writeFileSync(LAYOUT_FILE, JSON.stringify(layout));
  log(`flash set up in ${Math.round(Object.values(up.ms).reduce((a, b) => a + b, 0) / 1000)} s`);
  return layout;
}
