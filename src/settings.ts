// What the screen server remembers between restarts: the selected mode and its content (the
// message text and the uploaded picture). Lives in state/ next to the flash layout (gitignored).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodePng } from "./png.ts";

/** KEYSCREEN_STATE moves it elsewhere (used by tests). */
const STATE = process.env.KEYSCREEN_STATE ?? join(import.meta.dir, "..", "state");
const FILE = join(STATE, "settings.json");
const IMAGE = join(STATE, "image.png");
const SLEEP_FILE = join(STATE, "sleep-custom");

export interface Settings {
  mode?: string;
  message?: string;
  /** Sleep animation id (see sleep.ts). */
  sleep?: string;
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

/** The uploaded sleep picture/GIF, as uploaded. */
export function loadSleepUpload(): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(SLEEP_FILE));
  } catch {
    return undefined;
  }
}

export function saveSleepUpload(bytes: Uint8Array) {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(SLEEP_FILE + ".tmp", bytes);
  renameSync(SLEEP_FILE + ".tmp", SLEEP_FILE);
}

/** A screen-sized picture kept in state/ (e.g. the drawing), or undefined. */
export function loadStatePng(name: string, w: number, h: number): Uint8Array | undefined {
  try {
    const img = decodePng(new Uint8Array(readFileSync(join(STATE, name))));
    return img.width === w && img.height === h ? img.rgba : undefined;
  } catch {
    return undefined;
  }
}

export function saveStatePng(name: string, rgba: Uint8Array, w: number, h: number) {
  mkdirSync(STATE, { recursive: true });
  const file = join(STATE, name);
  writeFileSync(file + ".tmp", encodePng(rgba, w, h));
  renameSync(file + ".tmp", file);
}
