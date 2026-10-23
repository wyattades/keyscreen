// Test cases shown on the dashboard. Add new ones near the top; archive old ones by setting
// `archived` to a short reason instead of deleting them, so their history stays visible.
// Pictures use plain big letters/numbers that match exactly what the screen shows.
import { FrameStreamer } from "./legacy/stream.ts";
import { LiveScreen } from "../src/live.ts";
import { textFrame } from "./sheet.ts";
import { bigText, numberFrame, sparkleFrame, whiteFrame } from "./frames.ts";
import { Cmd } from "../src/qk108.ts";
import { SCRATCH_BLOCKS, hex, textGif, type TestCase } from "./harness.ts";
import { ensureLayout, MANAGED_BLOCKS } from "../src/layout.ts";

const BAD_WHITE = { label: "BAD: ALL WHITE", rgba: whiteFrame() };
const BAD_DOWNLOADING = { label: "BAD: DOWNLOADING", rgba: textFrame("DOWNLOADING") };
/** 5x5 white square, matching the dashboard pad's brush. */
function dot(rgba: Uint8Array, x: number, y: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && px < 240 && py >= 0 && py < 136) rgba.set([255, 255, 255, 255], (py * 240 + px) * 4);
    }
  }
}

/** A doodle (smiley) for the expected-screens picture. */
function sampleDrawing(): Uint8Array {
  const rgba = new Uint8Array(240 * 136 * 4);
  for (let i = 0; i < 240 * 136; i++) rgba[i * 4 + 3] = 255;
  for (let t = 0; t < 360; t += 4) {
    const r = (t * Math.PI) / 180;
    dot(rgba, Math.round(120 + 50 * Math.cos(r)), Math.round(68 + 50 * Math.sin(r)));
  }
  dot(rgba, 102, 52);
  dot(rgba, 138, 52);
  for (let t = 20; t <= 160; t += 6) {
    const r = (t * Math.PI) / 180;
    dot(rgba, Math.round(120 + 28 * Math.cos(r)), Math.round(76 + 22 * Math.sin(r)));
  }
  return rgba;
}

const isQgif = (b: Uint8Array, at = 8) => b[at] === 0x51 && b[at + 1] === 0x47 && b[at + 2] === 0x49 && b[at + 3] === 0x46;

export const cases: TestCase[] = [
  {
    id: "setup-layout",
    title: "One-time setup",
    description:
      `Sets up the screen's flash for the tests and the screen service: ${MANAGED_BLOCKS} free blocks for live streaming, plus three stored frames (WAIT, DONE and a blank one). Run once, or again if tests say the layout is missing.`,
    success: "1 the screen's Downloading screen for about 15 s, then 2 WAIT, then 3 DONE.",
    noLayout: true,
    expect: () => [
      { label: "1 DOWNLOADING 15 SEC", rgba: textFrame("DOWNLOADING") },
      { label: "2 WAIT", rgba: bigText("WAIT") },
      { label: "3 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
    ],
    async run({ s, log, idle }) {
      const layout = await ensureLayout(s, log, true);
      log(`layout: ${JSON.stringify(layout)}`);
      await s.switchTable([layout.frames.WAIT], layout.total, "flip");
      log("2 WAIT");
      await idle(2000);
      await s.switchTable([layout.frames.DONE], layout.total, "flip");
      log("3 DONE");
    },
  },
  {
    id: "screen-check",
    title: "Is the screen chip responding?",
    description: "Read-only ping. Run this after a power cycle, or if a test fails right away, to see if the screen chip answers.",
    success: "Nothing changes on screen. The log says the link is usb.",
    readOnly: true,
    noLayout: true,
    expect: () => [{ label: "1 NO CHANGE", rgba: bigText("NO CHANGE") }],
    async run({ s, log }) {
      log(`link: ${await s.status()}`);
      log(`table: ${hex(await s.readTable(), 8, 16)}`);
    },
  },
  {
    id: "header-start-erase",
    title: "Erase from a chosen block (table header)",
    description:
      "The slot table starts with a byte every tool leaves at 0. This sets it to 8 to see if the erase then starts at block 8 instead of 0. If it works, the stream can recycle flash with no pause.",
    success: "1 WAIT, 2-5 A B C D, 6 WAIT for 3 s, then 7 A, 8 E, 9 C, 10 D, 11 DONE. No white, no Downloading.",
    archived: "Answered: no. Step 7 white (block 0 erased) and step 8 E with white artifacts (block 8 NOT erased). The header byte is ignored; the erase always clears blocks 0..allocation-1 (2026-10-22).",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 A", rgba: bigText("A") },
      { label: "3 B", rgba: bigText("B") },
      { label: "4 C", rgba: bigText("C") },
      { label: "5 D", rgba: bigText("D") },
      { label: "6 WAIT 3 SEC", rgba: bigText("WAIT") },
      { label: "7 A", rgba: bigText("A") },
      { label: "8 E", rgba: bigText("E") },
      { label: "9 C", rgba: bigText("C") },
      { label: "10 D", rgba: bigText("D") },
      { label: "11 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      { label: "BAD: 8 GARBLED", rgba: bigText("GARBLED") },
      BAD_DOWNLOADING,
    ],
    async run({ s, log, show, idle, layout }) {
      const { WAIT, DONE } = layout.frames;
      await show(WAIT, "1 WAIT", 800);
      const prep = await s.funcErase(12, [WAIT], layout.total);
      log(`setup: erased blocks 0-11 in ${prep.eraseMs} ms`);
      const markers: [number, string][] = [[0, "A"], [8, "B"], [10, "C"], [11, "D"]];
      const entry: Record<number, { start: number; length: number }> = {};
      for (const [b, t] of markers) {
        const g = textGif(t);
        await s.writeImage(b, g);
        entry[b] = { start: b, length: g.length };
      }
      for (const [i, [b, t]] of markers.entries()) await show(entry[b], `${i + 2} ${t} (block ${b})`, 1200);
      await show(WAIT, "6 WAIT; erase with header start = 8, allocation 2, at the end", 3000);
      const r = await s.funcErase(2, [WAIT], layout.total, { start: 8, allocation: 2, headerStart: 8 });
      log(`erase replied in ${r.eraseMs} ms, status 0x${r.reply[7].toString(16)}`);
      await idle(800);
      const e = textGif("E");
      await s.writeImage(8, e);
      await show(entry[0], "7 block 0: expect A (white = still erased from block 0)", 2000);
      await show({ start: 8, length: e.length }, "8 block 8: expect E (garbled = block 8 was not erased)", 2000);
      await show(entry[10], "9 block 10: expect C (white = erased too far)", 2000);
      await show(entry[11], "10 block 11: expect D", 2000);
      await show(DONE, "11 DONE", 300);
    },
  },
  {
    id: "lag-meter",
    title: "Lag meter (corrected, 2.5 min)",
    archived: "Failed 2026-10-22: with a 600 ms start-up correction the screen went white right away, then garbled; stopped by the user. The screen reads ahead of what it shows, so it needs data written ~0.7 s+ before display. The correction made us write too late.",
    description:
      "10 fps, plus a 0.6 s correction for the screen's start-up delay, and a longer run to see any remaining drift. While it runs, this card shows a counter going up 4 times a second; the keyboard shows the same counter.",
    success:
      "1 WAIT, then 2 a counter going up 4 times a second for 2.5 minutes, then 3 DONE. Report how many counts the keyboard is behind this card's counter at the start, the middle and the end. Hoped for: about 1-2 at the start, and no more than that at the end. No white or garbled frames.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 COUNTER", rgba: bigText("12") },
      { label: "2 GOING UP", rgba: bigText("13") },
      { label: "2 FOR 2.5 MIN", rgba: bigText("14") },
      { label: "3 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout }) {
      const { WAIT, DONE } = layout.frames;
      const PERIOD = 250, fps = 10, lead = 3, startDelayMs = 600;
      const live = new LiveScreen(s, { streamBlocks: 15, parkBlocks: 1, totalBlocks: layout.total, fallback: WAIT, fps, leadFrames: lead, startDelayMs, log });
      log("1 WAIT, clearing");
      const t0 = Date.now() + 2000;
      const count = () => Math.max(0, Math.floor((Date.now() - t0) / PERIOD));
      await live.start(bigText("0"));
      log(`SYNC ${t0} ${PERIOD}`);
      log(`2 counter running; ${fps} fps, buffer ${(lead * 1000) / fps} ms, start-up correction ${startDelayMs} ms`);
      let shown = -1;
      const ticker = setInterval(() => {
        const n = count();
        if (n !== shown) {
          shown = n;
          live.push(bigText(String(n)));
        }
      }, 10);
      await new Promise((r) => setTimeout(r, 152000));
      clearInterval(ticker);
      await live.stop(DONE);
      log(`3 DONE: ${JSON.stringify(live.stats)}`);
    },
  },
  {
    id: "readahead-pad",
    title: "Read-ahead: small vs padded filler",
    archived: "Result 2026-10-22: A (normal) 4 then 5 counts behind; B (1.5 KB frames) 3 then 3. Padding cut ~0.25 s and stopped the creep, so the read-ahead is at least partly byte-based.",
    description:
      "Is the screen's ~1 s read-ahead a fixed time or a fixed number of bytes? Phase A streams normal tiny filler frames; phase B pads every frame to ~1.5 KB (same picture, more bytes). If the keyboard is clearly less behind in B, padding cuts the delay.",
    success:
      "1 WAIT, 2 'A' + counter for 40 s, WAIT briefly, 3 'B' + counter for 40 s, 4 DONE. Compare with this card's counter and report counts behind near the start and end of each phase (e.g. 'A: 4, 4. B: 2, 2'). No white or garbled frames.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 PHASE A COUNTER", rgba: bigText("A 37") },
      { label: "  WAIT BRIEFLY", rgba: bigText("WAIT") },
      { label: "3 PHASE B COUNTER", rgba: bigText("B 205") },
      { label: "4 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout }) {
      const { WAIT, DONE } = layout.frames;
      const PERIOD = 250, fps = 10, lead = 3;
      const t0 = Date.now() + 2500;
      const count = () => Math.max(0, Math.floor((Date.now() - t0) / PERIOD));
      for (const [phase, pad] of [["A", 0], ["B", 1500]] as const) {
        const live = new LiveScreen(s, { streamBlocks: 15, parkBlocks: 1, totalBlocks: layout.total, fallback: WAIT, fps, leadFrames: lead, padFrameBytes: pad, log });
        log(`phase ${phase}: clearing (WAIT)`);
        await live.start(bigText(`${phase} ${count()}`));
        if (phase === "A") log(`SYNC ${t0} ${PERIOD}`);
        log(`${phase === "A" ? 2 : 3} phase ${phase}: ${fps} fps, buffer ${(lead * 1000) / fps} ms, frames padded to ${pad || "no"} bytes`);
        let shown = -1;
        const ticker = setInterval(() => {
          const n = count();
          if (n !== shown) {
            shown = n;
            live.push(bigText(`${phase} ${n}`));
          }
        }, 10);
        await new Promise((r) => setTimeout(r, 40000));
        clearInterval(ticker);
        await live.stop(phase === "A" ? WAIT : DONE);
        log(`phase ${phase} done: ${JSON.stringify(live.stats)}`);
      }
      log("4 DONE");
    },
  },
  {
    id: "reaction-latency",
    title: "Reaction test: real delay",
    archived: "Result 2026-10-23: medians no padding ~580 ms (437-583), 1.5 KB ~925 ms (687-957), 3 KB ~843 ms (one 1945 mid-recycle; 488/521 right after a fresh stream). Padding hurts. Delay creeps up within a stream (~1% slow playback) and resets to ~0.5 s on a fresh stream.",
    description:
      "Measures the delay without counting. Watch only the keyboard: it shows GO now and then, and you click SEEN on this card each time. The computer works out the delay (assuming a typical 250 ms reaction time).",
    success:
      "Keyboard only: 1 WAIT, 2 black, 3 GO now and then (12 times in a row, no breaks), 4 DONE. Click SEEN each time you see GO, until DONE. Report success if it ran; the delays are in the log.",
    react: "Watch the keyboard. Click SEEN as soon as it shows GO. Keep going until it says DONE (12 GOs).",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 BLACK", rgba: bigText("") },
      { label: "3 GO: CLICK SEEN", rgba: bigText("GO") },
      { label: "4 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout, onInput }) {
      const { WAIT, DONE } = layout.frames;
      const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const rand = (a: number, b: number) => a + Math.random() * (b - a);
      const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
      const clicks: number[] = [];
      onInput((line) => {
        const m = line.match(/^seen (\d+)$/);
        if (m) clicks.push(Number(m[1]));
      });
      /** First click after `after` (clicks before it are dropped), or undefined after `timeoutMs`. */
      const clickAfter = async (after: number, timeoutMs: number) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          while (clicks.length && clicks[0] < after) clicks.shift();
          if (clicks.length) return clicks.shift()!;
          await sleepMs(10);
        }
        return undefined;
      };

      // Typical human reaction time; subtracted from each click. Settings are compared like-for-like anyway.
      const rt = 250;
      log("1 WAIT");

      const results: string[] = [];
      // One stream for the whole test (no WAIT between settings); padding changes between rounds.
      const live = new LiveScreen(s, { streamBlocks: 13, parkBlocks: 3, totalBlocks: layout.total, fallback: WAIT, fps: 10, leadFrames: 3, log });
      await live.start(bigText(""));
      log("2 black. 3 watch for GO (12 in a row, no breaks)");
      for (const pad of [0, 1500, 3000]) {
        live.setPad(pad);
        log(`setting: frames padded to ${pad || "no"} bytes`);
        const delays: number[] = [];
        for (let k = 0; k < 4; k++) {
          await sleepMs(rand(2000, 3500));
          const sent = Date.now();
          live.push(bigText("GO"));
          const c = await clickAfter(sent, 4500);
          const d = c !== undefined ? c - sent - rt : undefined;
          if (d !== undefined) delays.push(d);
          log(`  pad ${pad} trial ${k + 1}: ${d !== undefined ? `delay ~${Math.round(d)} ms (click ${Math.round(c! - sent)} ms after send)` : "missed"}`);
          await sleepMs(700);
          live.push(bigText(""));
        }
        // The fastest click is least padded by reaction time, so it's the best estimate of the real delay.
        const best = delays.length ? Math.round(Math.min(...delays)) + " ms" : "n/a";
        const line = `RESULT pad ${pad}: best ~${best}, median ~${Number.isNaN(median(delays)) ? "n/a" : Math.round(median(delays)) + " ms"} (${delays.length}/4 trials)`;
        results.push(line);
        log(line);
      }
      await live.stop(DONE);
      log(`4 DONE (assumed reaction ${rt} ms). ${results.join("; ")}`);
    },
  },
  {
    id: "readahead-sweep",
    title: "Read-ahead: padding sweep",
    archived: "Replaced by the reaction test (counting by eye was too hard). Never run.",
    description:
      "Padding frames to 1.5 KB cut the delay a bit. This tries 1.5 KB, 3 KB and 5 KB frames (15 s each) to see how low the delay goes. Same picture in every phase; only the bytes differ.",
    success:
      "1 WAIT, then 2 'B' + counter, 3 'C' + counter, 4 'D' + counter (15 s each, WAIT briefly between), then 5 DONE. Report counts behind this card's counter once in each phase (e.g. 'B 3, C 2, D 1'). No white or garbled frames.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 B 1.5 KB", rgba: bigText("B 37") },
      { label: "3 C 3 KB", rgba: bigText("C 110") },
      { label: "4 D 5 KB", rgba: bigText("D 182") },
      { label: "5 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout }) {
      const { WAIT, DONE } = layout.frames;
      const PERIOD = 250, fps = 10, lead = 3;
      const t0 = Date.now() + 2500;
      const count = () => Math.max(0, Math.floor((Date.now() - t0) / PERIOD));
      const phases = [["B", 1500], ["C", 3000], ["D", 5000]] as const;
      for (const [i, [phase, pad]] of phases.entries()) {
        const live = new LiveScreen(s, { streamBlocks: 15, parkBlocks: 1, totalBlocks: layout.total, fallback: WAIT, fps, leadFrames: lead, padFrameBytes: pad, log });
        await live.start(bigText(`${phase} ${count()}`));
        if (i === 0) log(`SYNC ${t0} ${PERIOD}`);
        log(`${i + 2} phase ${phase}: frames padded to ${pad} bytes (${(pad * fps) / 1000} KB/s)`);
        let shown = -1;
        const ticker = setInterval(() => {
          const n = count();
          if (n !== shown) {
            shown = n;
            live.push(bigText(`${phase} ${n}`));
          }
        }, 10);
        await new Promise((r) => setTimeout(r, 15000));
        clearInterval(ticker);
        await live.stop(i === phases.length - 1 ? DONE : WAIT);
        log(`phase ${phase} done: ${JSON.stringify(live.stats)}`);
      }
      log("5 DONE");
    },
  },
  {
    id: "draw-pad",
    title: "Drawing pad (live delay)",
    archived: "Result 2026-10-22: ~2 s delay at every setting (1 s, 0.5 s, 0.25 s). Led to the lag tests; replaced by the reaction test.",
    description:
      "While this runs, draw on the black pad on this card: whatever you draw shows up on the keyboard screen. Use the Delay buttons to try a 1 s, 0.5 s and 0.25 s safety buffer, and feel how quickly your strokes appear.",
    success:
      "1 WAIT, 2 DRAW, then 3 your strokes appear on the keyboard screen (after the chosen delay) for 90 s, then 4 DONE. No white or garbled screens. Note which delay felt OK.",
    interactive: "Draw with the mouse. Try each Delay setting for a bit. Runs for 90 s.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 DRAW", rgba: bigText("DRAW") },
      { label: "3 YOUR DRAWING", rgba: sampleDrawing() },
      { label: "4 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout, onInput }) {
      const { WAIT, DONE } = layout.frames;
      const W = 240, H = 136;
      const canvas = new Uint8Array(W * H * 4);
      const clear = () => {
        canvas.fill(0);
        for (let i = 0; i < W * H; i++) canvas[i * 4 + 3] = 255;
      };
      clear();
      let dirty = false, dots = 0;
      const live = new LiveScreen(s, { streamBlocks: 14, parkBlocks: 2, totalBlocks: layout.total, fallback: WAIT, fps: 8, leadFrames: 8, log });
      onInput((line) => {
        const [cmd, a, b] = line.split(" ");
        if (cmd === "dot") {
          dot(canvas, Number(a), Number(b));
          dots++;
          dirty = true;
        } else if (cmd === "clear") {
          clear();
          dirty = true;
        } else if (cmd === "lead") {
          live.setLead(Number(a));
          log(`delay set to ${Number(a)} frames = ${Number(a) * 125} ms`);
        }
      });
      log("1 WAIT, clearing");
      await live.start(bigText("DRAW"));
      log("2 DRAW: start drawing");
      const pusher = setInterval(() => {
        if (!dirty) return;
        dirty = false;
        live.push(canvas.slice());
      }, 50);
      await new Promise((r) => setTimeout(r, 90000));
      clearInterval(pusher);
      await live.stop(DONE);
      log(`4 DONE: ${dots} dots drawn; ${JSON.stringify(live.stats)}`);
    },
  },
  {
    id: "fast-writes",
    title: "Faster writes",
    archived: "Passed 2026-10-22: all letters clean. 1 in flight 910 ms (18.5 KB/s); 4, 8 and 16 in flight all 304 ms (55 KB/s, USB's ~1 packet/ms ceiling). LiveScreen now uses 4.",
    description:
      "Writes four letters, each faster than the last: 1, 4, 8 and 16 packets in flight instead of waiting for each reply. Faster writes are the key to smooth, pause-free streaming.",
    success: "1 WAIT, then 2 A, 3 B, 4 C, 5 D (each clean, about 2 s), then 6 DONE. The log shows how fast each one wrote.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 A - 1 IN FLIGHT", rgba: bigText("A") },
      { label: "3 B - 4 IN FLIGHT", rgba: bigText("B") },
      { label: "4 C - 8 IN FLIGHT", rgba: bigText("C") },
      { label: "5 D - 16 IN FLIGHT", rgba: bigText("D") },
      { label: "6 DONE", rgba: bigText("DONE") },
      { label: "BAD: GARBLED LETTER", rgba: bigText("GARBLED") },
      BAD_WHITE,
      { label: "BAD: STUCK ON WAIT", rgba: bigText("WAIT") },
    ],
    async run({ s, log, show, layout }) {
      const { WAIT, DONE } = layout.frames;
      await show(WAIT, "1 WAIT", 500);
      const e = await s.funcErase(4, [WAIT], layout.total);
      log(`erased blocks 0-3 in ${e.eraseMs} ms`);
      const runs: [number, string, number][] = [[0, "A", 1], [1, "B", 4], [2, "C", 8], [3, "D", 16]];
      const written: [number, string, number][] = [];
      for (const [block, letter, window] of runs) {
        const g = textGif(letter);
        try {
          const ms = await s.writeAt(block * 65536, g, window);
          log(`${letter}: ${g.length} B with ${window} in flight in ${Math.round(ms)} ms = ${(g.length / ms).toFixed(1)} KB/s`);
          written.push([block, letter, g.length]);
        } catch (err) {
          log(`${letter} with ${window} in flight FAILED: ${(err as Error).message}`);
          break;
        }
      }
      for (const [i, [block, letter, len]] of written.entries()) await show({ start: block, length: len }, `${i + 2} ${letter}`, 2000);
      await show(DONE, "6 DONE", 300);
    },
  },
  {
    id: "stream-seamless",
    title: "Seamless never-ending stream",
    archived: "Passed 2026-10-22: 403 numbers in 60 s (6.7/s), 10 rotations, no WAIT, never white or garbled. Short (<0.5 s) pauses about every 5 s with the deliberately tiny 2-block stream area; measured content gaps 375-625 ms around each erase.",
    description:
      "Same random numbers through the same tiny stream area, but rotations hand over to a short parking stream instead of freezing. Now with 3x faster writes and a 0.5 s buffer. If this works, the second monitor can update forever without pausing.",
    success:
      "1 WAIT, then 2 numbers changing several times a second for the whole 60 s, with no freezes (a tiny skip about every 5 s is OK), then 3 DONE. No WAIT in the middle, never white, Downloading or garbled.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 NUMBERS CHANGING", rgba: numberFrame(4821) },
      { label: "2 NO FREEZES", rgba: numberFrame(937) },
      { label: "2 FOR 60 SECONDS", rgba: numberFrame(7710) },
      { label: "3 DONE", rgba: bigText("DONE") },
      { label: "BAD: FREEZE 2+ SEC", rgba: numberFrame(1234) },
      BAD_WHITE,
      BAD_DOWNLOADING,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout }) {
      const { WAIT, DONE } = layout.frames;
      const live = new LiveScreen(s, { streamBlocks: 2, parkBlocks: 13, totalBlocks: layout.total, fallback: WAIT, fps: 8, leadFrames: 4, log });
      const rand = () => numberFrame(Math.floor(Math.random() * 10000));
      log("1 WAIT, clearing");
      await live.start(rand());
      log("2 streaming (4 writes in flight, 0.5 s buffer)");
      const t0 = performance.now();
      const feeder = setInterval(() => live.push(rand()), 100);
      await new Promise((r) => setTimeout(r, 60000));
      clearInterval(feeder);
      await live.stop(DONE);
      const secs = (performance.now() - t0) / 1000;
      const st = live.stats;
      log(`3 DONE: ${st.contentFrames} numbers in ${secs.toFixed(0)} s (${(st.contentFrames / secs).toFixed(1)}/s), ${st.rotations} seamless rotations, ${st.fallbackRotations} WAIT rotations, max ${st.maxBehindFrames} frames behind lead, starved ~${(st.starvedMs / 1000).toFixed(1)} s`);
    },
  },
  {
    id: "stream-rotate",
    title: "Never-ending stream (rotation)",
    archived: "Passed 2026-10-22: 7 rotations in 60 s (6 parked + 1 WAIT), erases ~0.3 s, never white or Downloading. Each rotation froze updates ~3.2 s; replaced by the seamless version.",
    description:
      "Streams random numbers for 60 s through a deliberately tiny stream area, so it fills every ~8 s and has to recycle flash. This is how the second monitor will run forever without Downloading.",
    success:
      "1 WAIT, then 2 numbers changing fast. About every 8 s the number 3 freezes for 2-3 s, then 4 keeps changing. Every 4th freeze shows 5 WAIT for about a second instead. Ends on 6 DONE. Never white, never Downloading, never garbled.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 NUMBERS CHANGING", rgba: numberFrame(4821) },
      { label: "3 FREEZE 2-3 SEC", rgba: numberFrame(937) },
      { label: "4 CHANGING AGAIN", rgba: numberFrame(7710) },
      { label: "5 SOMETIMES WAIT", rgba: bigText("WAIT") },
      { label: "6 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      BAD_DOWNLOADING,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout }) {
      const { WAIT, DONE } = layout.frames;
      const live = new LiveScreen(s, { streamBlocks: 2, parkBlocks: 3, totalBlocks: layout.total, fallback: WAIT, fps: 8, leadFrames: 8, log });
      const rand = () => numberFrame(Math.floor(Math.random() * 10000));
      log("1 WAIT, clearing");
      await live.start(rand());
      log("2 streaming");
      const t0 = performance.now();
      const feeder = setInterval(() => live.push(rand()), 100);
      await new Promise((r) => setTimeout(r, 60000));
      clearInterval(feeder);
      await live.stop(DONE);
      const secs = (performance.now() - t0) / 1000;
      const st = live.stats;
      log(`6 DONE: ${st.contentFrames} numbers in ${secs.toFixed(0)} s, ${st.rotations} parked rotations + ${st.fallbackRotations} WAIT rotations, starved ~${(st.starvedMs / 1000).toFixed(1)} s`);
    },
  },
  {
    id: "stream-random",
    title: "Live random numbers, no Downloading",
    archived: "Superseded by the rotation tests, which stream the same random numbers and also clear flash without Downloading.",
    description:
      "The computer makes up a random number several times a second and streams it to the screen. The stream area is cleared first with the no-Downloading erase.",
    success: "1 WAIT, then 2 four-digit numbers changing several times a second for 30 s, then 3 DONE. Never Downloading.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 RANDOM NUMBERS", rgba: numberFrame(4821) },
      { label: "2 CHANGING FAST", rgba: numberFrame(937) },
      { label: "2 FOR 30 SECONDS", rgba: numberFrame(7710) },
      { label: "3 DONE", rgba: bigText("DONE") },
      BAD_DOWNLOADING,
    ],
    async run({ s, log, show, layout }) {
      const { WAIT, DONE } = layout.frames;
      await show(WAIT, "1 WAIT", 500);
      const e = await s.funcErase(SCRATCH_BLOCKS, [WAIT], layout.total);
      log(`stream area cleared (no Downloading) in ${e.eraseMs} ms`);
      const streamer = new FrameStreamer(s, { startBlock: 0, blocks: SCRATCH_BLOCKS, totalBlocks: layout.total, restEntry: DONE, fps: 8, leadFrames: 8, log });
      const rand = () => Math.floor(Math.random() * 10000);
      const t0 = performance.now();
      await streamer.start(numberFrame(rand()));
      log("2 numbers streaming");
      streamer.push(numberFrame(rand()));
      const timer = setTimeout(() => void streamer.stop(), 30000);
      await streamer.run(() => streamer.push(numberFrame(rand())));
      clearTimeout(timer);
      await streamer.stop();
      const secs = (performance.now() - t0) / 1000;
      log(`3 DONE: streamed ${streamer.stats.contentFrames} numbers in ${secs.toFixed(1)} s (${(streamer.stats.contentFrames / secs).toFixed(1)}/s)`);
    },
  },
  {
    id: "read-probe",
    title: "Can we read flash back?",
    description: "Read-only. Asks the screen for data at a flash address where a known picture is stored.",
    success: "Nothing changes on screen. The log ends with a VERDICT line.",
    readOnly: true,
    archived: "Answered: no. READ_FUNC (14) at a nonzero address (0x100000) got no reply and froze the screen chip (2026-10-22). Reads only return the table.",
    expect: () => [{ label: "1 NO CHANGE", rgba: bigText("NO CHANGE") }],
    async run({ s, log, layout }) {
      const addr = layout.frames.WAIT.start * 65536;
      const r = await s.readAt(Cmd.ReadTable, addr);
      log(`READ_FUNC @ 0x${addr.toString(16)}: ${hex(r, 0, 24)}${isQgif(r) ? " <-- QGIF" : ""}`);
    },
  },
  {
    id: "lag-meter-8fps",
    title: "Lag meter (8 fps)",
    archived: "Result 2026-10-22: ~5 counts behind at the start, ~12 at the end of 45 s. The screen plays ~4% slower than 8 fps (likely 130 ms frames), so lag grows; plus ~1 s start-up delay.",
    description:
      "Measures the real delay. While it runs, this card shows a big counter that goes up 4 times a second, and the keyboard screen shows the same counter, made live by the computer. The difference tells us the delay (each count = 0.25 s).",
    success:
      "1 WAIT, then 2 a counter going up 4 times a second for 45 s, then 3 DONE. Report how many counts the keyboard is behind this card's counter, once near the start and once near the end (e.g. 'start 7 behind, end 7 behind').",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 COUNTER", rgba: bigText("12") },
      { label: "2 GOING UP", rgba: bigText("13") },
      { label: "2 4 PER SECOND", rgba: bigText("14") },
      { label: "3 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
    ],
    async run({ s, log, layout }) {
      const { WAIT, DONE } = layout.frames;
      const PERIOD = 250, lead = 2;
      const live = new LiveScreen(s, { streamBlocks: 14, parkBlocks: 2, totalBlocks: layout.total, fallback: WAIT, fps: 8, leadFrames: lead, log });
      log("1 WAIT, clearing");
      const t0 = Date.now() + 2000; // counter starts at 0 a moment after the stream starts
      const count = () => Math.max(0, Math.floor((Date.now() - t0) / PERIOD));
      await live.start(bigText("0"));
      log(`SYNC ${t0} ${PERIOD}`);
      log(`2 counter running; software buffer ${lead} frames = ${lead * 125} ms`);
      let shown = -1;
      const ticker = setInterval(() => {
        const n = count();
        if (n !== shown) {
          shown = n;
          live.push(bigText(String(n)));
        }
      }, 10);
      await new Promise((r) => setTimeout(r, 47000));
      clearInterval(ticker);
      await live.stop(DONE);
      log(`3 DONE: ${JSON.stringify(live.stats)}`);
    },
  },
  {
    id: "lag-meter-10fps",
    title: "Lag meter (10 fps)",
    archived: "Result 2026-10-22: ~4 counts behind at the start, ~6 at the end of 45 s. Drift down from ~4% to ~1% (near eyeball precision); start-up delay ~0.7 s (1.0 s minus the 0.3 s buffer).",
    description:
      "Same as before, but the stream runs at 10 fps (100 ms per frame) to test whether the growing lag came from the screen rounding 125 ms frames to 130 ms. While it runs, this card shows a counter going up 4 times a second; the keyboard shows the same counter.",
    success:
      "1 WAIT, then 2 a counter going up 4 times a second for 45 s, then 3 DONE. Report how many counts the keyboard is behind this card's counter near the start and near the end. Success = the same at both.",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 COUNTER", rgba: bigText("12") },
      { label: "2 GOING UP", rgba: bigText("13") },
      { label: "2 4 PER SECOND", rgba: bigText("14") },
      { label: "3 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
    ],
    async run({ s, log, layout }) {
      const { WAIT, DONE } = layout.frames;
      const PERIOD = 250, fps = 10, lead = 3;
      const live = new LiveScreen(s, { streamBlocks: 14, parkBlocks: 2, totalBlocks: layout.total, fallback: WAIT, fps, leadFrames: lead, log });
      log("1 WAIT, clearing");
      const t0 = Date.now() + 2000;
      const count = () => Math.max(0, Math.floor((Date.now() - t0) / PERIOD));
      await live.start(bigText("0"));
      log(`SYNC ${t0} ${PERIOD}`);
      log(`2 counter running; ${fps} fps, software buffer ${lead} frames = ${(lead * 1000) / fps} ms`);
      let shown = -1;
      const ticker = setInterval(() => {
        const n = count();
        if (n !== shown) {
          shown = n;
          live.push(bigText(String(n)));
        }
      }, 10);
      await new Promise((r) => setTimeout(r, 47000));
      clearInterval(ticker);
      await live.stop(DONE);
      log(`3 DONE: ${JSON.stringify(live.stats)}`);
    },
  },
  {
    id: "reaction-latency-v1",
    title: "Reaction test: real delay (v1)",
    archived: "Result 2026-10-23: no padding = median delay ~660 ms (4/4). The padded phase began after a WAIT that looked like the end, so its GOs went unclicked; then the 1-block parking stream overflowed with padding, the test crashed and the screen showed garbage, then white. Fixed: parking streams never pad; one stream, no WAIT between settings.",
    description:
      "Measures the delay without counting. Watch only the keyboard: it shows GO now and then, and you click SEEN on this card each time. The computer works out the delay (assuming a typical 250 ms reaction time).",
    success:
      "Keyboard only: 1 WAIT, 2 black, 3 GO now and then (12 times in all), 4 DONE. Click SEEN each time you see GO. Report success if it ran; the delays are in the log.",
    react: "Watch the keyboard. Click SEEN as soon as it shows GO (12 times).",
    expect: () => [
      { label: "1 WAIT", rgba: bigText("WAIT") },
      { label: "2 BLACK", rgba: bigText("") },
      { label: "3 GO: CLICK SEEN", rgba: bigText("GO") },
      { label: "4 DONE", rgba: bigText("DONE") },
      BAD_WHITE,
      { label: "BAD: GARBLED", rgba: bigText("GARBLED") },
    ],
    async run({ s, log, layout, onInput }) {
      const { WAIT, DONE } = layout.frames;
      const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const rand = (a: number, b: number) => a + Math.random() * (b - a);
      const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
      const clicks: number[] = [];
      onInput((line) => {
        const m = line.match(/^seen (\d+)$/);
        if (m) clicks.push(Number(m[1]));
      });
      /** First click after `after` (clicks before it are dropped), or undefined after `timeoutMs`. */
      const clickAfter = async (after: number, timeoutMs: number) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          while (clicks.length && clicks[0] < after) clicks.shift();
          if (clicks.length) return clicks.shift()!;
          await sleepMs(10);
        }
        return undefined;
      };

      // Typical human reaction time; subtracted from each click. Settings are compared like-for-like anyway.
      const rt = 250;
      log("1 WAIT");

      const results: string[] = [];
      for (const pad of [0, 1500, 3000]) {
        const live = new LiveScreen(s, { streamBlocks: 15, parkBlocks: 1, totalBlocks: layout.total, fallback: WAIT, fps: 10, leadFrames: 3, padFrameBytes: pad, log });
        await live.start(bigText(""));
        log(`2 black; setting: frames padded to ${pad || "no"} bytes. 3 watch for GO`);
        const delays: number[] = [];
        for (let k = 0; k < 4; k++) {
          await sleepMs(rand(2000, 3500));
          const sent = Date.now();
          live.push(bigText("GO"));
          const c = await clickAfter(sent, 4500);
          const d = c !== undefined ? c - sent - rt : undefined;
          if (d !== undefined) delays.push(d);
          log(`  pad ${pad} trial ${k + 1}: ${d !== undefined ? `delay ~${Math.round(d)} ms (click ${Math.round(c! - sent)} ms after send)` : "missed"}`);
          await sleepMs(700);
          live.push(bigText(""));
        }
        await live.stop(WAIT);
        // The fastest click is least padded by reaction time, so it's the best estimate of the real delay.
        const best = delays.length ? Math.round(Math.min(...delays)) + " ms" : "n/a";
        const line = `RESULT pad ${pad}: best ~${best}, median ~${Number.isNaN(median(delays)) ? "n/a" : Math.round(median(delays)) + " ms"} (${delays.length}/4 trials)`;
        results.push(line);
        log(line);
      }
      await s.switchTable([DONE], layout.total, "flip");
      log(`4 DONE (assumed reaction ${rt} ms). ${results.join("; ")}`);
    },
  },
];
