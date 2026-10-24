// What the screen server remembers between restarts: the selected mode and its content (the
// message text and the uploaded picture). Lives in state/ next to the flash layout (gitignored).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "./png.ts";

/** KEYSCREEN_STATE moves it elsewhere (used by tests). */
const STATE = process.env.KEYSCREEN_STATE ?? join(import.meta.dir, "..", "state");
const FILE = join(STATE, "settings.json");
const IMAGE = join(STATE, "image.png");

export interface Settings {
  mode?: string;
  message?: string;
}

export function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Settings;
  } catch {
    return {};
  }
}

/** Merges `patch` into the saved settings. Writes a temp file and renames it, so a crash can't leave half a file. */
export function saveSettings(patch: Settings) {
  const next = { ...loadSettings(), ...patch };
  mkdirSync(STATE, { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify(next, null, 2) + "\n");
  renameSync(FILE + ".tmp", FILE);
}

/** The last uploaded picture (RGBA 240x136), if any. */
export function loadImage(w: number, h: number): Uint8Array | undefined {
  if (!existsSync(IMAGE)) return undefined;
  try {
    const img = decodePng(new Uint8Array(readFileSync(IMAGE)));
    return img.width === w && img.height === h ? img.rgba : undefined;
  } catch {
    return undefined;
  }
}

export function saveImage(rgba: Uint8Array, w: number, h: number) {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(IMAGE + ".tmp", encodePng(rgba, w, h));
  renameSync(IMAGE + ".tmp", IMAGE);
}
