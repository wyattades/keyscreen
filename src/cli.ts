#!/usr/bin/env bun
// keyscreen: control a keyboard's built-in screen.   Run `keyscreen help` for the full list.
import { readFileSync, writeFileSync } from "node:fs";
import { showStill, withScreen } from "./direct.ts";
import { Led, Leds } from "./leds.ts";
import { decodePng, fitImage, isPng } from "./png.ts";
import { DEFAULT_PORT, startServer } from "./server.ts";
import { renderText } from "./textframe.ts";

const HELP = `keyscreen: control a keyboard's built-in screen (tested on the Epomaker QK108)

Screen server (live modes, web page, API for other programs):
  serve [--fake] [--port N] [--mode ID]   start it (then open http://localhost:${DEFAULT_PORT})
                                          It starts in the mode used last time (with the same message and
                                          picture) unless --mode says otherwise. --fake uses a simulated
                                          screen, no keyboard needed (and doesn't remember anything unless
                                          --remember).

Commands for the running server:
  status                 what it's doing
  modes                  list modes
  mode <id>              switch mode (draw, ticker, clock, sysmon, life, stars, message, image)
  key <letters>          type into the key ticker
  draw <x0,y0> <x1,y1> [--color R,G,B] [--size N]   draw a line (Draw mode, 240x136)
  draw clear             clear the drawing
  reseed                 restart the Game of Life
  frame [out.png]        save what the screen is showing
  stop                   stop the server cleanly

While the computer is locked, the keyboard plays a stored animation (and nothing goes over USB):
  sleep                  show the sleep animation and the choices
  sleep <id>             choose it (sand, zzz, night, dark, custom, off = keep the live mode)
  sleep upload <file>    use your own PNG or animated GIF
  sleep try | wake       sleep now to see it on the keyboard, then wake up

Work with or without the server (without it, the picture stays on screen after exit):
  text <message>         show a message
  image <file.png>       show a picture, scaled to fit

Straight on the keyboard (stop the server first):
  check                  is the screen chip responding?
  info                   screen size
  time                   sync the screen's clock
  setup [--force]        set up the flash layout (the screen shows Downloading once)
  blank                  show a blank screen

Lock-light icons on the screen (works anytime):
  leds <none|num|caps|num+caps>

Server address: KEYSCREEN_SERVER (default http://localhost:${DEFAULT_PORT}).`;

const SERVER = process.env.KEYSCREEN_SERVER ?? `http://localhost:${DEFAULT_PORT}`;
const log = (m: string) => console.log(m);
const [cmd = "help", ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = () =>
  args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && args[i - 1] !== "--force"));

async function serverUp(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER}/api/status`, { signal: AbortSignal.timeout(700) });
    return r.ok;
  } catch {
    return false;
  }
}

async function call(path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${SERVER}${path}`, init);
  } catch {
    fail(`the screen server isn't running at ${SERVER}. Start it with: keyscreen serve`);
  }
  if (!res.ok) fail(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `server said ${res.status}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

const post = (path: string, body: unknown) =>
  call(path, {
    method: "POST",
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  });

function fail(msg: string): never {
  console.error(`keyscreen: ${msg}`);
  process.exit(1);
}

async function requireNoServer() {
  if (await serverUp())
    fail("the screen server is running and owns the screen. Stop it first (Ctrl-C in its terminal).");
}

function loadImage(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  if (!isPng(bytes)) fail(`${path} isn't a PNG`);
  return bytes;
}

switch (cmd) {
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;

  // ---- server ----
  case "serve": {
    const port = Number(flag("--port") ?? DEFAULT_PORT);
    startServer({
      port,
      fake: args.includes("--fake"),
      mode: flag("--mode"),
      remember: args.includes("--remember") || undefined,
    });
    break;
  }
  case "status": {
    const s = await call("/api/status");
    console.log(
      `${s.state}${s.fake ? " (simulated screen)" : ""}, mode: ${s.mode}${s.lastError ? `, last error: ${s.lastError}` : ""}`,
    );
    if (s.note) console.log(s.note);
    if (s.stats) console.log(`frames sent: ${s.stats.contentFrames}, flash recycles: ${s.stats.rotations}`);
    break;
  }
  case "modes": {
    const s = await call("/api/status");
    for (const m of s.modes) console.log(`${m.id === s.mode ? "*" : " "} ${m.id.padEnd(8)} ${m.blurb}`);
    break;
  }
  case "mode":
    if (!args[0]) fail("usage: keyscreen mode <id>   (see: keyscreen modes)");
    await post("/api/mode", { id: args[0] });
    console.log(`mode: ${args[0]}`);
    break;
  case "key": {
    const text = args.join(" ");
    if (!text) fail("usage: keyscreen key <letters>");
    for (const ch of text.toUpperCase()) await post("/api/input", { type: "key", key: ch });
    break;
  }
  case "draw": {
    if (args[0] === "clear") {
      await post("/api/input", { type: "clear" });
      break;
    }
    const [a, b] = positional();
    const pt = (p?: string) => (p ?? "").split(",").map(Number);
    const [x0, y0] = pt(a),
      [x1, y1] = pt(b ?? a);
    if ([x0, y0, x1, y1].some(Number.isNaN)) fail("usage: keyscreen draw <x0,y0> <x1,y1> [--color R,G,B] [--size N]");
    const color = (flag("--color") ?? "255,255,255").split(",").map(Number);
    await post("/api/mode", { id: "draw" });
    await post("/api/input", { type: "draw", segs: [[x0, y0, x1, y1]], color, size: Number(flag("--size") ?? 2) });
    break;
  }
  case "reseed":
    await post("/api/mode", { id: "life" });
    await post("/api/input", { type: "reseed" });
    break;
  case "frame": {
    const res = (await call("/frame.png")) as Response;
    const out = args[0] ?? "frame.png";
    writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
    console.log(`saved ${out}`);
    break;
  }

  case "sleep": {
    const [sub, file] = args;
    if (!sub) {
      const s = (await call("/api/status")).sleep;
      for (const m of s.modes) console.log(`${m.id === s.mode ? "*" : " "} ${m.id.padEnd(9)} ${m.blurb}`);
      console.log(s.asleep ? `asleep${s.locked ? " (computer locked)" : " (trying it)"}` : "awake");
    } else if (sub === "upload") {
      if (!file) fail("usage: keyscreen sleep upload <file.png|file.gif>");
      await post("/api/sleep/upload", new Uint8Array(readFileSync(file)));
      console.log("sleep animation: your picture");
    } else if (sub === "try" || sub === "wake") {
      await post("/api/sleep", { action: sub });
      console.log(sub === "try" ? "asleep (run `keyscreen sleep wake` to wake it)" : "awake");
    } else {
      await post("/api/sleep", { mode: sub });
      console.log(`sleep animation: ${sub}`);
    }
    break;
  }
  case "stop":
    await post("/api/shutdown", {});
    console.log("server stopping");
    break;

  // ---- server or direct ----
  case "text": {
    const text = args.join(" ");
    if (!text) fail("usage: keyscreen text <message>");
    if (await serverUp()) await post("/text", text);
    else await withScreen(log, (s, layout) => showStill(s, layout, renderText(text)));
    console.log("shown");
    break;
  }
  case "image": {
    if (!args[0]) fail("usage: keyscreen image <file.png>");
    const bytes = loadImage(args[0]);
    if (await serverUp()) await post("/image", bytes);
    else await withScreen(log, (s, layout) => showStill(s, layout, fitImage(decodePng(bytes))));
    console.log("shown");
    break;
  }

  // ---- direct ----
  case "check":
    await requireNoServer();
    await withScreen(log, async (s) => console.log(`screen chip responding, link: ${await s.status()}`));
    break;
  case "info":
    await requireNoServer();
    await withScreen(log, async (s) => console.log(await s.info()));
    break;
  case "time":
    await requireNoServer();
    await withScreen(log, (s) => s.syncTime());
    console.log("clock synced");
    break;
  case "setup": {
    await requireNoServer();
    const { Screen } = await import("./qk108.ts");
    const { ensureLayout } = await import("./layout.ts");
    const s = await Screen.connect(15000, log);
    try {
      await ensureLayout(s, log, args.includes("--force"));
      console.log("flash layout ready");
    } finally {
      s.close();
    }
    break;
  }
  case "blank":
    await requireNoServer();
    await withScreen(log, (s, layout) => s.switchTable([layout.frames.BLANK], layout.total, "flip"));
    break;

  case "leds": {
    const want = (args[0] ?? "none").toLowerCase();
    let bits = 0;
    for (const part of want.split("+")) {
      if (part === "num") bits |= Led.Num;
      else if (part === "caps") bits |= Led.Caps;
      else if (part !== "none" && part !== "off") fail("usage: keyscreen leds <none|num|caps|num+caps>");
    }
    const leds = new Leds();
    leds.set(bits);
    leds.close();
    console.log(`lock icons: ${want} (the computer resets them on the next Caps/Num key press)`);
    break;
  }

  default:
    console.error(`unknown command "${cmd}"\n`);
    console.log(HELP);
    process.exit(1);
}
