// The keyboard screen server: owns the QK108 screen and shows live content from modes or other
// programs. Started by `keyscreen serve`; then open http://localhost:4110.
//
// HTTP API (every endpoint has a matching `keyscreen` command):
//   GET  /api/status      state, current mode, list of modes, stats       keyscreen status / keyscreen modes
//   POST /api/mode        {"id": "clock"}                                  keyscreen mode <id>
//   POST /api/input       a mode message, e.g. {"type":"key","key":"A"}    keyscreen key / draw / reseed
//   POST /text            body: plain text  -> Message mode                keyscreen text "..."
//   POST /image           body: PNG or raw RGBA 240x136 -> Image mode      keyscreen image <file>
//   GET  /frame.png       what the screen is showing (or about to)         keyscreen frame [out.png]
//   POST /api/sleep       {"mode": "zzz"} sets the sleep animation;        keyscreen sleep <id>
//                         {"action": "try" | "wake"} sleeps/wakes now      keyscreen sleep try / wake
//   POST /api/sleep/upload body: PNG or GIF -> custom sleep animation      keyscreen sleep upload <file>
//   GET  /api/sleep/preview.png?mode=ID  frames side by side (x-frames, x-fps headers)
//   POST /api/shutdown    stop the server cleanly                          keyscreen stop
//   WS   /ws              JSON mode messages; binary messages = images
import { join } from "node:path";
import { allModes, ImageMode, MessageMode, TickerMode, type Mode } from "./modes.ts";
import { decodePng, encodePng, fitImage, isPng } from "./png.ts";
import { ScreenService, SCREEN_H, SCREEN_W } from "./service.ts";
import { watchScreenLock } from "./lock.ts";
import { renderText } from "./textframe.ts";
import { loadImage, loadSettings, loadSleepUpload, saveImage, saveSettings, saveSleepUpload } from "./settings.ts";
import { builtinSleep, decodeCustom, DEFAULT_SLEEP, encodeSleep, SLEEP_MODES, type SleepFrames } from "./sleep.ts";

export const DEFAULT_PORT = 4110;
const UI = join(import.meta.dir, "ui", "index.html");

export interface ServerOptions {
  port?: number;
  /** Use a simulated screen instead of the keyboard (no USB). */
  fake?: boolean;
  /** Mode to start in (default: the one selected last time, else clock). */
  mode?: string;
  /** Save the mode, message and picture to state/ and restore them at start (default: on unless fake). */
  remember?: boolean;
}

export function startServer(opts: ServerOptions = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const logLines: string[] = [];
  const log = (m: string) => {
    const line = `[${new Date().toLocaleTimeString()}] ${m}`;
    console.log(line);
    logLines.push(line);
    if (logLines.length > 200) logLines.shift();
  };

  const service = new ScreenService(log, { fake: opts.fake });
  const modes = allModes();
  let mode: Mode | undefined;
  let note = "";
  // A simulated server (tests, screenshots) must not overwrite what the real one remembers.
  const remember = opts.remember ?? !opts.fake;
  const save: typeof saveSettings = (patch) => {
    if (!remember) return;
    try {
      saveSettings(patch);
    } catch (e) {
      log(`couldn't save settings: ${(e as Error).message}`);
    }
  };

  function setMode(id: string) {
    const next = modes.find((m) => m.id === id);
    if (!next) throw new Error(`unknown mode "${id}" (modes: ${modes.map((m) => m.id).join(", ")})`);
    if (next === mode) return;
    mode?.stop();
    note = "";
    mode = next;
    mode.start({ show: (rgba) => service.showRgba(rgba), log, note: (m) => (note = m) });
    log(`mode: ${mode.name}`);
    save({ mode: id });
  }

  function showImage(bytes: Uint8Array) {
    let rgba: Uint8Array;
    if (isPng(bytes)) rgba = fitImage(decodePng(bytes));
    else if (bytes.length === SCREEN_W * SCREEN_H * 4) rgba = bytes;
    else if (bytes.length === SCREEN_W * 135 * 4) {
      rgba = new Uint8Array(SCREEN_W * SCREEN_H * 4);
      rgba.set(bytes);
      for (let i = SCREEN_W * 135; i < SCREEN_W * SCREEN_H; i++) rgba[i * 4 + 3] = 255;
    } else throw new Error("send a PNG, or raw RGBA of 240x136 (or 240x135)");
    setMode("image");
    (mode as ImageMode).setImage(rgba);
    if (remember) saveImage(rgba, SCREEN_W, SCREEN_H);
  }

  function handleMessage(msg: Record<string, unknown>) {
    if (msg.type === "mode" && typeof msg.id === "string") setMode(msg.id);
    else if (msg.type === "text" && typeof msg.text === "string" && mode?.id !== "message") {
      setMode("message");
      mode!.input?.(msg);
    } else if (msg.type === "key" && mode?.id !== "ticker") {
      setMode("ticker");
      mode!.input?.(msg);
    } else mode?.input?.(msg);
    if (msg.type === "text" && mode instanceof MessageMode) save({ message: mode.message });
  }

  // ---- sleep: while the computer is locked, the keyboard plays a stored animation ----
  let sleepMode = (remember && loadSettings().sleep) || DEFAULT_SLEEP;
  if (!SLEEP_MODES.some((m) => m.id === sleepMode)) sleepMode = DEFAULT_SLEEP;
  let locked = false;
  let manualSleep = false;
  // One target object per animation, so asking for the same one again doesn't rewrite the flash.
  const sleepTargets = new Map<string, { gif?: Uint8Array; first: Uint8Array; name: string }>();

  let customUpload: Uint8Array | undefined; // used when not remembering (simulated server)

  function sleepFramesFor(id: string): SleepFrames | undefined {
    if (id === "custom") {
      const up = remember ? loadSleepUpload() : customUpload;
      return up ? decodeCustom(up) : undefined;
    }
    return builtinSleep(id);
  }

  function sleepTarget(id: string) {
    let t = sleepTargets.get(id);
    if (!t) {
      const name = SLEEP_MODES.find((m) => m.id === id)?.name ?? id;
      // "Dark" shows the blank frame that's already stored; nothing to write.
      if (id === "dark") t = { first: renderText(""), name };
      else {
        const f = sleepFramesFor(id) ?? builtinSleep(DEFAULT_SLEEP)!;
        t = { gif: encodeSleep(f), first: f.frames[0], name };
      }
      sleepTargets.set(id, t);
    }
    return t;
  }

  /** Sleeps or wakes to match: locked (or "try it"), unless the sleep mode is "off". */
  function applySleep() {
    if ((locked || manualSleep) && sleepMode !== "off") service.sleep(sleepTarget(sleepMode));
    else service.wake();
  }

  function setSleepMode(id: string) {
    if (!SLEEP_MODES.some((m) => m.id === id))
      throw new Error(`unknown sleep mode "${id}" (${SLEEP_MODES.map((m) => m.id).join(", ")})`);
    if (id === "custom" && !(remember ? loadSleepUpload() : customUpload))
      throw new Error("upload a picture or GIF first");
    sleepMode = id;
    save({ sleep: id });
    log(`sleep animation: ${id}`);
    applySleep();
  }

  function setSleepUpload(bytes: Uint8Array) {
    const f = decodeCustom(bytes); // throws if it isn't a PNG/GIF
    if (remember) saveSleepUpload(bytes);
    else customUpload = bytes;
    sleepTargets.delete("custom");
    log(`sleep picture uploaded: ${f.frames.length} frame${f.frames.length > 1 ? "s" : ""} at ${f.fps} fps`);
    setSleepMode("custom");
  }

  /** A strip of up to 48 frames (left to right) for the page to animate; headers say how many and how fast. */
  function sleepPreview(id: string): Response {
    if (id === "off") return new Response("no preview", { status: 404 });
    const f = id === "dark" ? { frames: [sleepTarget("dark").first], fps: 1 } : sleepFramesFor(id);
    if (!f) return new Response("no picture uploaded", { status: 404 });
    const step = Math.max(1, Math.ceil(f.frames.length / 48));
    const picked = f.frames.filter((_, i) => i % step === 0);
    const strip = new Uint8Array(SCREEN_W * picked.length * SCREEN_H * 4);
    picked.forEach((fr, k) => {
      for (let y = 0; y < SCREEN_H; y++)
        strip.set(
          fr.subarray(y * SCREEN_W * 4, (y + 1) * SCREEN_W * 4),
          (y * SCREEN_W * picked.length + k * SCREEN_W) * 4,
        );
    });
    return new Response(new Uint8Array(encodePng(strip, SCREEN_W * picked.length, SCREEN_H)), {
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
        "x-frames": String(picked.length),
        "x-fps": String(f.fps / step),
      },
    });
  }

  const status = () => ({
    state: service.state,
    fake: !!opts.fake,
    lastError: service.lastError,
    mode: mode?.id,
    note,
    keySource: mode instanceof TickerMode ? mode.keySource : null,
    modes: modes.map((m) => ({ id: m.id, name: m.name, blurb: m.blurb })),
    stats: service.stats ?? null,
    sleep: {
      mode: sleepMode,
      modes: SLEEP_MODES,
      asleep: service.asleep,
      locked,
      trying: manualSleep,
      hasUpload: !!(remember ? loadSleepUpload() : customUpload),
    },
    updatedAt: service.updatedAt,
    log: logLines.slice(-8),
  });

  const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);

  const server = Bun.serve({
    port,
    idleTimeout: 60,
    async fetch(req, srv) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/ws" && srv.upgrade(req)) return undefined;
        if (url.pathname === "/" && req.method === "GET") return new Response(Bun.file(UI));
        if (url.pathname === "/frame.png") {
          return new Response(new Uint8Array(encodePng(service.preview, SCREEN_W, SCREEN_H)), {
            headers: { "content-type": "image/png", "cache-control": "no-store" },
          });
        }
        if (url.pathname === "/api/status") return json(status());
        if (url.pathname === "/api/mode" && req.method === "POST") {
          setMode(String(((await req.json()) as { id: string }).id));
          return json({ ok: true });
        }
        if (url.pathname === "/api/input" && req.method === "POST") {
          handleMessage((await req.json()) as Record<string, unknown>);
          return json({ ok: true });
        }
        if (url.pathname === "/api/sleep" && req.method === "POST") {
          const body = (await req.json()) as { mode?: string; action?: "try" | "wake" };
          if (body.mode) setSleepMode(body.mode);
          if (body.action === "try") manualSleep = true;
          if (body.action === "wake") manualSleep = false;
          if (body.action) applySleep();
          return json({ ok: true });
        }
        if (url.pathname === "/api/sleep/upload" && req.method === "POST") {
          setSleepUpload(new Uint8Array(await req.arrayBuffer()));
          return json({ ok: true });
        }
        if (url.pathname === "/api/sleep/preview.png") return sleepPreview(url.searchParams.get("mode") ?? sleepMode);
        if (url.pathname === "/api/shutdown" && req.method === "POST") {
          setTimeout(() => void shutdown(), 50);
          return json({ ok: true });
        }
        if (url.pathname === "/text" && req.method === "POST") {
          handleMessage({ type: "text", text: await req.text() });
          return json({ ok: true });
        }
        if (url.pathname === "/image" && req.method === "POST") {
          showImage(new Uint8Array(await req.arrayBuffer()));
          return json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      } catch (e) {
        return json({ error: (e as Error).message }, { status: 400 });
      }
    },
    websocket: {
      message(ws, data) {
        try {
          if (typeof data === "string") handleMessage(JSON.parse(data));
          else showImage(new Uint8Array(data));
        } catch (e) {
          ws.send(JSON.stringify({ error: (e as Error).message }));
        }
      },
    },
  });

  log(`screen server on http://localhost:${port}${opts.fake ? " (simulated screen, no USB)" : ""}`);
  // Restore what was showing last time.
  const saved = remember ? loadSettings() : {};
  const message = modes.find((m) => m instanceof MessageMode) as MessageMode | undefined;
  if (saved.message !== undefined) message?.setText(saved.message);
  const image = modes.find((m) => m instanceof ImageMode) as ImageMode | undefined;
  const savedImage = remember ? loadImage(SCREEN_W, SCREEN_H) : undefined;
  if (image && savedImage) image.last = savedImage;
  const startMode = opts.mode ?? (saved.mode && modes.some((m) => m.id === saved.mode) ? saved.mode : "clock");
  setMode(startMode);
  void service.run();
  // Follow the computer's screen lock (not for the simulated screen: "try it" still works there).
  const stopLockWatch = opts.fake
    ? () => {}
    : watchScreenLock((l) => {
        locked = l;
        log(l ? "computer locked" : "computer unlocked");
        applySleep();
      }, log);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    log("stopping");
    mode?.stop();
    stopLockWatch();
    await service.stop().catch(() => {});
    server.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
