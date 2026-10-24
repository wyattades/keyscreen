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
//   POST /api/shutdown    stop the server cleanly                          keyscreen stop
//   WS   /ws              JSON mode messages; binary messages = images
import { join } from "node:path";
import { allModes, ImageMode, TickerMode, type Mode } from "./modes.ts";
import { decodePng, encodePng, fitImage, isPng } from "./png.ts";
import { ScreenService, SCREEN_H, SCREEN_W } from "./service.ts";

export const DEFAULT_PORT = 4110;
const UI = join(import.meta.dir, "ui", "index.html");

export interface ServerOptions {
  port?: number;
  /** Use a simulated screen instead of the keyboard (no USB). */
  fake?: boolean;
  /** Mode to start in. */
  mode?: string;
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

  function setMode(id: string) {
    const next = modes.find((m) => m.id === id);
    if (!next) throw new Error(`unknown mode "${id}" (modes: ${modes.map((m) => m.id).join(", ")})`);
    if (next === mode) return;
    mode?.stop();
    note = "";
    mode = next;
    mode.start({ show: (rgba) => service.showRgba(rgba), log, note: (m) => (note = m) });
    log(`mode: ${mode.name}`);
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
          return new Response(new Uint8Array(encodePng(service.current, SCREEN_W, SCREEN_H)), {
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
  setMode(opts.mode ?? "clock");
  void service.run();

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    log("stopping");
    mode?.stop();
    await service.stop().catch(() => {});
    server.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}
