#!/usr/bin/env node
// usage: node src/cli.ts <command>
//   time              sync the screen clock once
//   info              print screen size
//   keepalive [secs]  sync, then keep the screen connected (forever, or for secs)
//   sparkle [secs]    flash a random lock icon on every key press (needs the input group)
//   run               keepalive + sparkle together (Ctrl-C to stop)
//   flipbook-test [switch-only]  upload 4 frames, then switch between them with table-only writes (REPLACES stored GIFs)
//   meter [--demo|--idle] [--no-clock] [--24h] [--reupload]  clock when idle; typing fills a bar that explodes when full
//   draw-test         upload a full-screen test pattern as a 1-frame GIF (REPLACES all stored GIFs) and time it
import { Keyboard, Screen, keepalive, type SlotEntry, type SwitchMode } from "../../src/qk108.ts";
import { startSparkle } from "./sparkle.ts";
import { demoKeys, meterFrames, runMeter } from "./meter.ts";
import { onKeyDown } from "../../src/keys.ts";
import { encodeQgif } from "../../src/qgif.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FrameStreamer } from "./stream.ts";
import { numberFrame } from "../frames.ts";
import { squareFrame } from "../sheet.ts";
import { sleep } from "../../src/hidraw.ts";

const stamp = () => new Date().toLocaleTimeString();
const log = (m: string) => console.log(`[${stamp()}] ${m}`);
const hex = (b: Uint8Array, n = b.length) => Buffer.from(b.subarray(0, n)).toString("hex").replace(/(..)/g, "$1 ").trim();

async function withScreen<T>(fn: (s: Screen) => Promise<T>): Promise<T> {
  const s = await Screen.connect(15000, log);
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

const [cmd = "time", arg] = process.argv.slice(2);

switch (cmd) {
  case "time":
    await withScreen((s) => s.syncTime());
    log("time synced");
    break;
  case "info":
    console.log(await withScreen((s) => s.info()));
    break;
  case "mode": {
    const kb = new Keyboard();
    console.log({ screenMode: await kb.screenModeOn() });
    kb.close();
    break;
  }
  case "keepalive": {
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    if (arg) setTimeout(() => ac.abort(), Number(arg) * 1000);
    await keepalive({ signal: ac.signal, log });
    break;
  }
  case "draw-test": {
    // 240x136 (the web tool pads the 135-row panel to a multiple of 4): color bars,
    // a white square top-left, and a black diagonal so orientation and scaling are obvious.
    const w = 240, h = 136;
    const bars = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let c = bars[Math.floor((x * bars.length) / w)];
        if (x < 24 && y < 24) c = [255, 255, 255];
        if (Math.abs(x - (y * w) / h) < 3) c = [0, 0, 0];
        rgba.set([...c, 255], (y * w + x) * 4);
      }
    }
    const gif = encodeQgif([{ rgba }], { width: w, height: h, fps: 1 });
    mkdirSync("lab/legacy/state", { recursive: true });
    const saved = `lab/legacy/state/draw-test-${Date.now()}.qgif`;
    writeFileSync(saved, gif);
    log(`encoded ${gif.length} B, saved ${saved}`);
    await withScreen(async (s) => {
      log(`slot table before: ${hex(await s.readTable(), 30)}`);
      const t0 = performance.now();
      try {
        const r = await s.uploadGifs([gif], {
          onProgress: (sent, total) => process.stdout.write(`\r  writing ${Math.round((sent / total) * 100)}%`),
        });
        console.log();
        log(`uploaded ${r.bytes} B in ${r.packets} packets, ${r.blocks} block(s), total ${Math.round(performance.now() - t0)} ms`);
        console.log(r.ms);
      } catch (e) {
        console.log();
        log(`upload failed: ${(e as Error).message}; closing session`);
        await s.abortUpload().catch(() => {});
        throw e;
      }
      log(`slot table after:  ${hex(await s.readTable(), 30)}`);
    });
    break;
  }
  case "flipbook-test": {
    // 4 frames: solid colour + a black square in a different corner, uploaded once.
    // Then all slots are re-pointed at one frame at a time using table-only writes.
    const w = 240, h = 136;
    const frames = [
      { name: "RED", c: [255, 0, 0], corner: [0, 0] },
      { name: "GREEN", c: [0, 255, 0], corner: [1, 0] },
      { name: "BLUE", c: [0, 0, 255], corner: [0, 1] },
      { name: "YELLOW", c: [255, 255, 0], corner: [1, 1] },
    ];
    const gifs = frames.map(({ c, corner: [cx, cy] }) => {
      const rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inSquare = (cx ? x >= w - 48 : x < 48) && (cy ? y >= h - 48 : y < 48);
          rgba.set([...(inSquare ? [0, 0, 0] : c), 255], (y * w + x) * 4);
        }
      }
      return encodeQgif([{ rgba }], { width: w, height: h, fps: 1 });
    });
    const slotsFor = (k: number) => frames.map(() => ({ start: k, length: gifs[k].length }));
    const own = frames.map((_, i) => ({ start: i, length: gifs[i].length }));
    await withScreen(async (s) => {
      // The screen drops off USB after ~4 s of silence, so ping while waiting.
      const idle = async (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          await s.status();
          await sleep(Math.min(1000, Math.max(0, end - performance.now())));
        }
      };
      if (arg === "switch-only") {
        log("skipping upload; using the 4 frames already stored");
      } else {
        const r = await s.uploadGifs(gifs);
        log(`uploaded ${frames.length} frames in ${Object.values(r.ms).reduce((a, b) => a + b, 0)} ms`);
      }
      log("make sure the GIF page is showing (Fn + Right Shift). Starting in 6 s…");
      await idle(6000);
      for (const mode of ["minimal", "full"] as const) {
        log(`--- ${mode} table switches ---`);
        for (const k of [1, 2, 3, 0, 1, 2, 3, 0]) {
          const ms = await s.switchTable(slotsFor(k), frames.length, mode);
          log(`all slots -> ${frames[k].name} (${ms.toFixed(0)} ms)`);
          await idle(2500);
        }
      }
      await s.switchTable(own, frames.length, "full");
      log("restored: each slot points at its own frame");
      log(`table: ${hex(await s.readTable(), 30)}`);
    });
    break;
  }
  case "flip-stress": {
    // Uses the 4 frames flipbook-test stored (blocks 0-3, 16,840 B each). Runs phases from
    // safest to fastest and stops at the first missed reply, without sending any cleanup.
    const len = 16840, names = ["RED", "GREEN", "BLUE", "YELLOW"];
    const slotsFor = (k: number) => [0, 1, 2, 3].map(() => ({ start: k, length: len }));
    const phases: { name: string; mode: SwitchMode; settle: number; gap: number; n: number }[] = [
      { name: "A flip, 1 s apart", mode: "flip", settle: 0, gap: 1000, n: 20 },
      { name: "B flip, 300 ms gap", mode: "flip", settle: 0, gap: 300, n: 30 },
      { name: "C flip, 100 ms gap", mode: "flip", settle: 0, gap: 100, n: 40 },
      { name: "D flip, back-to-back", mode: "flip", settle: 0, gap: 0, n: 60 },
    ];
    await withScreen(async (s) => {
      const idle = async (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          if (end - performance.now() > 900) await s.status();
          await sleep(Math.min(900, Math.max(0, end - performance.now())));
        }
      };
      let total = 0;
      for (const p of phases) {
        log(`--- ${p.name}: ${p.n} switches ---`);
        const times: number[] = [];
        const t0 = performance.now();
        for (let i = 0; i < p.n; i++) {
          const k = (total + 1) % 4;
          try {
            times.push(await s.switchTable(slotsFor(k), 4, p.mode));
          } catch (e) {
            log(`FAILED on switch ${i + 1} of phase ${p.name} (switch #${total + 1} overall, target ${names[k]}): ${(e as Error).message}`);
            log("stopping without cleanup; power-cycle the keyboard to recover");
            process.exit(2);
          }
          total++;
          if (p.settle) await sleep(p.settle);
          if (p.gap) await idle(p.gap);
        }
        const secs = (performance.now() - t0) / 1000;
        times.sort((a, b) => a - b);
        log(`ok: switch ms min ${times[0].toFixed(0)} / median ${times[times.length >> 1].toFixed(0)} / max ${times[times.length - 1].toFixed(0)}, ${(p.n / secs).toFixed(1)} switches/s`);
      }
      log(`all phases passed: ${total} switches. Last frame shown: ${names[total % 4]}`);
    });
    break;
  }
  case "meter": {
    // Clock + typing meter on the GIF page (Fn + Right Shift). --demo fakes typing, --idle reads no keys.
    const flags = process.argv.slice(3);
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    const keys = flags.includes("--idle")
      ? () => () => {}
      : flags.includes("--demo")
        ? demoKeys
        : (onKey: () => void) => onKeyDown(onKey, (e) => log(`key events: ${e.message}`));
    const clock = !flags.includes("--no-clock");
    await runMeter({ log, signal: ac.signal, keys, clock, reupload: flags.includes("--reupload"), clockOptions: { hour12: !flags.includes("--24h") } });
    log("meter stopped");
    break;
  }
  case "start-erase-test": {
    // Does the plain-session erase honour a start block? Markers in blocks 0, 8, 9, 11, then erase
    // start=8 count=1 with the table allocating 12 blocks.
    const { total, rest } = JSON.parse(readFileSync("lab/legacy/state/stream-layout.json", "utf8")) as { total: number; rest: SlotEntry };
    const lvl = (n: number) => ({ start: rest.start + n, length: rest.length });
    const gif = (c: number[]) => encodeQgif([{ rgba: squareFrame(c) }], { width: 240, height: 136, fps: 1 });
    const markers: [number, string, Uint8Array][] = [
      [0, "RED", gif([255, 0, 0])],
      [8, "GREEN", gif([0, 255, 0])],
      [9, "BLUE", gif([0, 0, 255])],
      [11, "YELLOW", gif([255, 255, 0])],
    ];
    const magenta = gif([255, 0, 255]);
    await withScreen(async (s) => {
      const idle = async (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          await s.status();
          await sleep(Math.min(900, Math.max(0, end - performance.now())));
        }
      };
      const show = async (block: number, len: number, label: string, ms: number) => {
        await s.switchTable([{ start: block, length: len }], total, "flip");
        log(label);
        await idle(ms);
      };
      await show(lvl(6).start, rest.length, "1. half bar (setup starting)", 1500);
      const prep = await s.funcErase(12, [lvl(6)], total);
      log(`   setup: erased blocks 0-11 from block 0 in ${prep.eraseMs} ms`);
      for (const [block, name, data] of markers) await s.writeImage(block, data);
      log("   markers written");
      for (const [block, name, data] of markers) await show(block, data.length, `2. marker block ${block}: expect ${name}`, 1500);
      await s.switchTable([lvl(6)], total, "flip");
      for (let n = 5; n > 0; n--) {
        log(`3. half bar; start-block erase (start 8, count 1) in ${n}…`);
        await idle(1000);
      }
      try {
        const r = await s.funcErase(1, [lvl(6)], total, { start: 8, allocation: 12 });
        log(`   erase replied in ${r.eraseMs} ms, reply byte 7 = 0x${r.reply[7].toString(16)}`);
      } catch (e) {
        log(`   erase FAILED: ${(e as Error).message}. Stopping; power-cycle the keyboard to recover.`);
        process.exit(2);
      }
      await idle(1000);
      log(`   wrote MAGENTA into block 8 in ${Math.round(await s.writeImage(8, magenta))} ms`);
      await show(0, markers[0][2].length, "4. block 0: expect RED (white = erase ignored the start)", 2500);
      await show(8, magenta.length, "5. block 8: expect CLEAN MAGENTA (green/magenta mix = block 8 not erased)", 2500);
      await show(9, markers[2][2].length, "6. block 9: expect BLUE (white = erased past the count)", 2500);
      await show(11, markers[3][2].length, "7. block 11: expect YELLOW (white = erased to end of allocation)", 2500);
      await show(lvl(12).start, rest.length, "8. full bar (meter intact)", 2000);
      await show(lvl(0).start, rest.length, "9. empty bar - done", 500);
    });
    break;
  }
  case "func-erase-test": {
    // Can FLASH_ERASE work inside the plain 10/11 session (no "Downloading")? Uses the stream layout:
    // blocks 0-15 hold old stream data (dirty), meter frames start at block 16.
    const { total, rest } = JSON.parse(readFileSync("lab/legacy/state/stream-layout.json", "utf8")) as { total: number; rest: SlotEntry };
    const lvl = (n: number) => ({ start: rest.start + n, length: rest.length });
    const red = encodeQgif([{ rgba: squareFrame([255, 0, 0]) }], { width: 240, height: 136, fps: 1 });
    await withScreen(async (s) => {
      const idle = async (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          await s.status();
          await sleep(Math.min(900, Math.max(0, end - performance.now())));
        }
      };
      await s.switchTable([lvl(6)], total, "flip");
      for (let n = 5; n > 0; n--) {
        log(`1. half bar; plain-session erase of block 0 in ${n}… (Downloading here = failed)`);
        await idle(1000);
      }
      try {
        const r = await s.funcErase(1, [lvl(6)], total);
        log(`   erase replied in ${r.eraseMs} ms (total ${r.totalMs} ms), reply byte 7 = 0x${r.reply[7].toString(16)}`);
      } catch (e) {
        log(`   erase FAILED: ${(e as Error).message}. Stopping; power-cycle the keyboard to recover.`);
        process.exit(2);
      }
      await idle(1500);
      log(`   wrote RED into block 0 in ${Math.round(await s.writeImage(0, red))} ms`);
      await s.switchTable([{ start: 0, length: red.length }], total, "flip");
      log("2. expect CLEAN RED with a black square (mixed/garbage = the erase didn't happen)");
      await idle(3000);
      for (const [n, label] of [[12, "FULL bar"], [6, "HALF bar"], [0, "EMPTY bar"]] as const) {
        await s.switchTable([lvl(n)], total, "flip");
        log(`3. expect ${label} (white = erased by mistake)`);
        await idle(2500);
      }
      log("4. done");
    });
    break;
  }
  case "stream-test": {
    // stream-test [seconds] [--upload]: live random numbers, streamed into a growing animation.
    // Layout: 16 stream blocks at the start of flash, meter frames after. --upload sets that up
    // (one long Downloading); otherwise the stream region is cleared with a quick erase (<2 s).
    const STREAM_BLOCKS = 16, LAYOUT = "lab/legacy/state/stream-layout.json";
    const seconds = Number(arg) > 0 ? Number(arg) : 45;
    await withScreen(async (s) => {
      let layout: { total: number; rest: SlotEntry } | undefined;
      if (process.argv.includes("--upload")) {
        log(`uploading meter frames after ${STREAM_BLOCKS} stream blocks (Downloading ~45 s)…`);
        const up = await s.uploadGifs(meterFrames(), { slots: 1, leadingBlocks: STREAM_BLOCKS });
        layout = { total: up.blocks, rest: up.entries[0] };
        mkdirSync("lab/legacy/state", { recursive: true });
        writeFileSync(LAYOUT, JSON.stringify(layout));
        await s.switchTable([layout.rest], layout.total, "flip");
        log(`upload done: ${layout.total} blocks; empty meter showing`);
      } else {
        layout = JSON.parse(readFileSync(LAYOUT, "utf8"));
        const ms = await s.quickErase(STREAM_BLOCKS, [layout!.rest], layout!.total);
        log(`stream region cleared with a quick erase in ${ms.total} ms`);
      }
      const { total, rest } = layout!;
      await sleep(1500);
      await s.status();

      const streamer = new FrameStreamer(s, { startBlock: 0, blocks: STREAM_BLOCKS, totalBlocks: total, restEntry: rest, fps: 8, leadFrames: 8, log });
      const rand = () => Math.floor(Math.random() * 10000);
      let current = rand();
      const t0 = performance.now();
      await streamer.start(numberFrame(current));
      log(`stream started: ${String(current).padStart(4, "0")} on screen now`);
      current = rand();
      streamer.push(numberFrame(current));
      const stopAt = setTimeout(() => void streamer.stop(), seconds * 1000);
      await streamer.run((e) => {
        const at = new Date(e.showAt).toLocaleTimeString([], { hour12: false }) + "." + String(e.showAt % 1000).padStart(3, "0");
        log(`${String(current).padStart(4, "0")} -> frame ${e.frame}, on screen at ${at} (${e.changedTiles} tiles, ${e.bytes} B, ${Math.round(e.writeMs)} ms)`);
        current = rand();
        streamer.push(numberFrame(current));
      });
      clearTimeout(stopAt);
      await streamer.stop();
      const secs = (performance.now() - t0) / 1000;
      log(`stopped after ${secs.toFixed(1)} s: ${streamer.stats.contentFrames} new numbers (${(streamer.stats.contentFrames / secs).toFixed(1)}/s), ${streamer.stats.emptyFrames} filler frames, ${Math.round((STREAM_BLOCKS * 65536 - streamer.bytesLeft) / 1024)} KB of ${STREAM_BLOCKS * 64} KB used`);
    });
    break;
  }
  case "quick-erase-test": {
    // Uses the layout erase-test left: 4 scratch blocks (0-3), meter frames from block 4, 21 blocks.
    // Erases blocks 0-3 inside a short download session while the half bar is showing.
    const w = 240, h = 136, total = 21, len = 16840, lvl = (n: number) => ({ start: 4 + n, length: len });
    // Use a different colour than last time: writing the same image over un-erased flash would look clean.
    const colors: Record<string, number[]> = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255] };
    const name = arg && arg in colors ? arg : "blue", color = colors[name];
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const center = Math.abs(x - w / 2) < 32 && Math.abs(y - h / 2) < 32;
        rgba.set([...(center ? [0, 0, 0] : color), 255], (y * w + x) * 4);
      }
    }
    const green = encodeQgif([{ rgba }], { width: w, height: h, fps: 1 });
    await withScreen(async (s) => {
      const idle = async (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          await s.status();
          await sleep(Math.min(900, Math.max(0, end - performance.now())));
        }
      };
      if (process.argv.includes("--upload")) {
        log("re-uploading meter frames after 4 scratch blocks (Downloading expected)…");
        const up = await s.uploadGifs(meterFrames(), { slots: 1, leadingBlocks: 4 });
        if (up.blocks !== total) throw new Error(`expected ${total} blocks, got ${up.blocks}`);
        await s.switchTable([lvl(0)], total, "flip");
        log("upload done; empty meter showing");
        await idle(2000);
      }
      const t = await s.readTable();
      if (t[9] !== 1 || t[10] !== total) throw new Error(`unexpected table ${hex(t, 16)}; run with --upload`);
      await s.switchTable([lvl(6)], total, "flip");
      // Make block 0 dirty with a different colour first, so a clean result can only come from the erase.
      const dirtyName = name === "blue" ? "green" : "blue";
      const dirtyRgba = rgba.slice();
      for (let i = 0; i < w * h; i++) if (dirtyRgba[i * 4] || dirtyRgba[i * 4 + 1] || dirtyRgba[i * 4 + 2]) dirtyRgba.set([...colors[dirtyName], 255], i * 4);
      const dirty = encodeQgif([{ rgba: dirtyRgba }], { width: w, height: h, fps: 1 });
      log(`   wrote ${dirtyName.toUpperCase()} into block 0 (to dirty it) in ${Math.round(await s.writeImage(0, dirty))} ms`);
      await s.switchTable([{ start: 0, length: dirty.length }], total, "flip");
      log(`0. ${dirtyName.toUpperCase()} (may look mixed if block 0 already held something)`);
      await idle(2500);
      await s.switchTable([lvl(6)], total, "flip");
      for (let n = 5; n > 0; n--) {
        log(`1. half bar; quick erase of blocks 0-3 in ${n}… (watch for Downloading)`);
        await idle(1000);
      }
      try {
        const ms = await s.quickErase(4, [lvl(6)], total, 200);
        log(`   quick erase done: ${JSON.stringify(ms)}`);
      } catch (e) {
        log(`   quick erase FAILED: ${(e as Error).message}; stopping`);
        process.exit(2);
      }
      await idle(2000);
      log(`   wrote ${name.toUpperCase()} into block 0 in ${Math.round(await s.writeImage(0, green))} ms`);
      await s.switchTable([{ start: 0, length: green.length }], total, "flip");
      log(`2. expect clean ${name.toUpperCase()} with a black square (dark/garbled mix = block 0 wasn't erased)`);
      await idle(3000);
      for (const [n, label] of [[12, "FULL bar"], [6, "HALF bar"], [0, "EMPTY meter"]] as const) {
        await s.switchTable([lvl(n)], total, "flip");
        log(`3. expect ${label} (white = erased by mistake)`);
        await idle(2500);
      }
      log("4. done; on the empty meter");
    });
    break;
  }
  case "erase-test": {
    // Can FLASH_ERASE run outside download mode (no "Downloading" screen) while a frame outside
    // the erased range is showing? Meter frames go after 4 scratch blocks at the start of flash.
    const w = 240, h = 136;
    const solid = (c: number[]) => {
      const rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const center = Math.abs(x - w / 2) < 32 && Math.abs(y - h / 2) < 32;
          rgba.set([...(center ? [0, 0, 0] : c), 255], (y * w + x) * 4);
        }
      }
      return encodeQgif([{ rgba }], { width: w, height: h, fps: 1 });
    };
    const red = solid([255, 0, 0]), green = solid([0, 255, 0]);
    await withScreen(async (s) => {
      const idle = async (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          await s.status();
          await sleep(Math.min(900, Math.max(0, end - performance.now())));
        }
      };
      log("uploading meter frames after 4 scratch blocks (Downloading expected)…");
      const up = await s.uploadGifs(meterFrames(), { slots: 1, leadingBlocks: 4 });
      const total = up.blocks, lvl = (n: number) => up.entries[n];
      log(`uploaded: ${total} blocks, meter level 0 at block ${lvl(0).start}`);
      const step = async (label: string, fn: () => Promise<unknown>, holdMs = 3000) => {
        await fn();
        log(label);
        await idle(holdMs);
      };
      await step("1. empty meter", () => s.switchTable([lvl(0)], total, "flip"), 2000);
      log(`   wrote RED into block 0 in ${Math.round(await s.writeImage(0, red))} ms`);
      await step("2. expect RED", () => s.switchTable([{ start: 0, length: red.length }], total, "flip"));
      await step("3. half bar (erase coming next)", () => s.switchTable([lvl(6)], total, "flip"), 1500);
      try {
        const { ms, reply } = await s.eraseFirstBlocks(1);
        log(`   erase of block 0 (no download mode) replied in ${Math.round(ms)} ms: ${Buffer.from(reply.subarray(0, 12)).toString("hex")}`);
      } catch (e) {
        log(`   erase FAILED: ${(e as Error).message}; stopping`);
        process.exit(2);
      }
      await idle(1500);
      log(`   wrote GREEN into block 0 in ${Math.round(await s.writeImage(0, green))} ms`);
      await step("4. expect clean GREEN (garbage = erase didn't work)", () => s.switchTable([{ start: 0, length: green.length }], total, "flip"));
      await step("5. expect FULL bar (meter frames intact)", () => s.switchTable([lvl(12)], total, "flip"));
      await step("6. back to empty meter", () => s.switchTable([lvl(0)], total, "flip"), 500);
    });
    break;
  }
  case "append-test": {
    // Can we write a new image into a pre-erased spare block without a full re-upload?
    // Re-uploads the meter with 8 spare blocks, writes one test frame per method, then flips to each.
    const w = 240, h = 136;
    const solid = (c: number[]) => {
      const rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const center = Math.abs(x - w / 2) < 32 && Math.abs(y - h / 2) < 32;
          rgba.set([...(center ? [0, 0, 0] : c), 255], (y * w + x) * 4);
        }
      }
      return encodeQgif([{ rgba }], { width: w, height: h, fps: 1 });
    };
    const tests = [
      { name: "CYAN", session: "bare" as const, img: solid([0, 255, 255]) },
      { name: "MAGENTA", session: "func" as const, img: solid([255, 0, 255]) },
      { name: "WHITE", session: "download" as const, img: solid([255, 255, 255]) },
    ];
    await withScreen(async (s) => {
      const idle = async (ms: number) => {
        const end = performance.now() + ms;
        while (performance.now() < end) {
          await s.status();
          await sleep(Math.min(900, Math.max(0, end - performance.now())));
        }
      };
      const frames = meterFrames();
      log(`uploading meter frames + 8 spare blocks…`);
      const up = await s.uploadGifs(frames, { slots: 1, spareBlocks: 8 });
      log(`uploaded: ${up.blocks} blocks allocated, spares start at block ${up.firstSpare} (${Object.values(up.ms).reduce((a, b) => a + b, 0)} ms)`);
      await idle(1500);
      const good: { name: string; block: number; length: number }[] = [];
      for (const [i, t] of tests.entries()) {
        const block = up.firstSpare + i;
        try {
          const ms = await s.writeImage(block, t.img, t.session);
          log(`${t.name}: wrote block ${block} with session=${t.session} in ${ms.toFixed(0)} ms (all packets accepted)`);
          good.push({ name: t.name, block, length: t.img.length });
        } catch (e) {
          const msg = (e as Error).message;
          log(`${t.name}: session=${t.session} FAILED: ${msg}`);
          if (msg.includes("timed out")) {
            log("screen stopped answering; stopping without flipping (power-cycle the screen to recover)");
            process.exit(2);
          }
        }
        await idle(500);
      }
      for (const g of good) {
        await s.switchTable([{ start: g.block, length: g.length }], up.blocks, "flip");
        log(`showing block ${g.block}: expect ${g.name} with a black square`);
        await idle(3000);
      }
      await s.switchTable([up.entries[0]], up.blocks, "flip");
      log("back to the empty meter");
    });
    break;
  }
  case "sparkle":
  case "run": {
    const ac = new AbortController();
    process.on("SIGINT", () => ac.abort());
    if (arg) setTimeout(() => ac.abort(), Number(arg) * 1000);
    const stop = startSparkle({ log });
    log("sparkle on: every key press flashes an icon");
    if (cmd === "run") await keepalive({ signal: ac.signal, log });
    else await new Promise((r) => ac.signal.addEventListener("abort", r));
    stop();
    break;
  }
  default:
    console.error("usage: node src/cli.ts time | info | mode | keepalive [secs] | sparkle [secs] | run | draw-test | flipbook-test | meter [--demo]");
    process.exit(1);
}
