# Investigation log

Everything we tried on the QK108 screen, in order: tests, measurements, failures and dead ends.
The working protocol distilled from this lives in [PROTOCOL.md](PROTOCOL.md).

Legend: **[verified]** = seen on this keyboard, **[web tool]** = read in the official image.rdmctmzt.com JS,
**[RT82]** = from RT82 projects only, **[Hub JS]** = read in Epomaker Hub, **[source]** = Epomaker QMK source.

## Devices

- Keyboard `36b0:30af` "RDMCTMZT Epomaker QK108" **[verified]**
  - if0 boot keyboard, if1 vendor page `0xFF60`/usage `0x61` (32-byte reports, VIA raw HID), if2 mouse/consumer/NKRO
- Screen controller `1919:1919` "RDR Epomaker QK108", behind the keyboard's internal hub (`1a40:0101`) **[verified]**
  - if0 boot mouse, if1 vendor page `0x00FF`/usage `0x01`, 64-byte in/out, no report ID
  - Only appears on USB after the keyboard gets `AA E0` (about 1.5 s later), then drops off after ~4 s
    unless a host keeps talking to it **[verified]**. Sending `AA 1C` every 3 s keeps it up indefinitely
    (30 s with no disconnect) **[verified]**. The constant 5.6 s reconnects seen at first were the web tool
    in Chrome sending `E0` every 400 ms but failing to open the root-only screen **[inferred]**
  - Screen is 240x135, rotate 0 (from the `AA 12` reply) **[verified]**

## Keyboard commands (32 bytes, to `36b0:30af` if1) **[web tool]**

| Bytes                       | Meaning                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AA E2 00…`                 | get screen mode. Reply byte **8** == 1 → on. This keyboard already reports 1 **[verified]**                                |
| `AA E0 00…`                 | open screen mode. Web tool repeats every 400 ms until the LCD connects. Echoed back; no visible effect here **[verified]** |
| `AA E3 00 00 00 01 00 00 n` | announce n GIFs before upload                                                                                              |

## LCD packets (64 bytes, to `1919:1919` if1) **[web tool]**

Layout: `AA cmd addrL addrM addrH len 00 00 payload[56]`. Each command gets a reply that echoes `AA cmd`.
Reply byte 7 == `0x0F` means rejected.

| Cmd                    | Meaning                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `10`                   | begin                                                                                              |
| `11`                   | end / exit                                                                                         |
| `12`                   | screen info: `AA 12 00 00 00 38`. Reply: width u16LE @20, height @22, rotate @26 (default 240x136) |
| `17`                   | set time (see below)                                                                               |
| `1B 14 15 16 18 19 1A` | GIF upload: start, read table, write table, commit, erase 64 KiB blocks, write, end                |
| `1C`                   | connection type + keepalive. Reply byte **9**: 0 BT, 1 2.4G, 2 USB **[verified]**                  |
| `1D` / `1E`            | static image erase / write: big-endian RGB565 with a 4-byte zero prefix                            |

### Time sync **[verified: our own sync works]**

Send `AA 10`, then this packet, then `AA 11`:

```
AA 17 00 00 00 38 00 00  Y Y Y Y  M M  DOW  D D  h h  m m  s s
```

One decimal digit per byte. DOW counts Sunday as 0 (JS `getDay()`).
Captured from the web tool on this keyboard **[verified]**:
`aa 17 00 00 00 38 00 00 02 00 02 06 01 00 03 02 01 02 03 00 05 05 03` = 2026-10, Wed(3), 21, 23:05:53.
Replies echo the request (same 64 bytes).

### Captured `AA 12` reply **[verified]**

`aa 12 00 00 00 38 00 00 aa bb 19 19 19 19 00 01 01 01 00 02 f0 00 87 00 9e 03 00`
→ width 0x00f0 = 240, height 0x0087 = 135, imageSize 0x9e, maxScreen 3, rotate 0

### Images **[web tool + RT82]**

GIFs must be encoded as QGIF (4x4 DXT1-like blocks, header `QGIF`). They are written to flash in
64 KiB blocks. No live-framebuffer / streaming command has been found.

## From reading the web tool JS (second pass)

- Every command the tool can send to the LCD: `10 11 12 14 15 16 17 18 19 1A 1B 1C 1D 1E`. There is no
  live-draw or framebuffer command. Every image path erases and writes flash in 64 KiB blocks (500 ms
  per erased block) **[web tool]**.
- `0xC0` is a flag byte inside the `0x15` partition-table payload, not a command **[web tool]**.
- Keepalive: once connected, the tool sends `AA 1C` every 3 s. If the reply says the link isn't USB (2), it sends
  `AA 1A`. With the tool open, the LCD stayed on the bus without dropping **[verified]**.
- On connect the tool runs: time sync (`10 17 11`), `1C`, then screen size (`10 12 11`) **[verified, captured]**.
- Static images (`1D`/`1E`) are stored as extra "screens" after the GIFs. A 240x135 RGB565 frame is
  64,800 B, which is 1 flash block (≈0.5 s erase + ~1,160 packets) **[web tool; timing estimated]**.
- Keyboard-side extra: `00 30 …` (33-byte) = device info: firmware version, battery, connect status **[web tool]**.

## Still images vs GIFs on the QK108 (tested 2026-10-21)

- `1D`/`1E` still-image upload is **rejected** on the QK108: the `1D` reply has byte 7 = `0x0F` **[verified]**.
  The web tool only uses image slots for the 8-screen model `36b0:30ee` (device-profiles.json). The QK108 gets the
  default profile, where every slot is a GIF, so a PNG/JPEG is sent as a one-frame QGIF through the GIF path
  (`14 15 16 18 19`) **[web tool]**.
- After the rejected attempt we closed the session (`1A`, time sync, `11`) and set the keyboard's screen count
  back to 3. The slot table was unchanged **[verified]**.
- `AA 14` slot table on this keyboard: `00 03 11` + entries `00 00 64 8a 03` / `04 00 41 27 06` / `0b 00 91 …`
  = 3 GIFs in 17 blocks (blocks 0, 4, 11) **[verified]**.
- Packet round trip (send, wait for echo): mean 3.2 ms, p95 4.2 ms over 300 `1C` pings, including our 2 ms
  poll interval **[verified]**.
- Estimate for one full-screen frame through the GIF path: a one-frame QGIF is roughly 17-33 KB, so 300-600
  packets (≈1-2 s), plus a 500 ms erase wait and a 500 ms settle wait = **≈2-3 s per frame**. Each frame also
  erases a 64 KiB flash block **[estimated]**.

## Live indicators (tested 2026-10-21)

- The screen's Caps/Num Lock icons update instantly on key presses, and **no USB traffic** shows up on either
  vendor channel while they do (12 Caps + 2 Num toggles monitored with `src/monitor.ts`) **[verified]**. The
  keyboard chip tells the screen chip over an internal link.
- The icon follows the **host's LED output report**, not the key itself: writing the QK108's
  `/sys/class/leds/input*::capslock/brightness` (root) blinked the screen icon on/off/on/off with no key press
  **[verified]**. This is a live host-to-screen channel, but only for indicator icons.
- The standard boot-keyboard LED report (interface 0, no report ID) has 5 bits: num, caps, scroll, compose, kana.
  We can set them without root by writing `[0x00, bits]` to the boot-keyboard hidraw (interface 0), which the
  udev rule makes write-only for plugdev (`src/leds.ts`) **[verified]**.
- Blink speed (`src/led-test.ts`): Caps was toggled at 2/5/10/20/50 Hz, and every write went through. On screen
  it kept up until it blinked faster than the eye could follow **[verified, by eye]**. Above ~20 Hz we can't tell
  real blinking from a merged/stuck icon by eye.
- Icons: Caps and Num **[verified]**. Scroll, Compose, Kana **[assumed]** (not watched during the test).

## Official source and live-drawing research (2026-10-21)

- Epomaker publishes QMK source for this keyboard: github.com/Epomaker/qk108 (one commit, 3817b9a8). The
  keyboard MCU is an Eastsoft ES32 FS026 with a custom bootloader **[source]**.
- All screen/UART logic is in a prebuilt `lib/rdr_lib/librdrcommon.a` that is not in the repo. Only
  `rdr_common.h` is published **[source]**.
- `quantum/via.c` keyboard commands (`0xAA` prefix) **[source, verified by reading]**:
  `E0` start screen USB mode, `E1` set screen USB mode with arg (byte 8), `E2` get status, `E3` sync GIF count.
  Nothing else in `E0-EF` is handled.
- The keyboard-to-screen UART uses small packets (`UART_BUF_SIZE 8`, commands `0x11/0x22/0x33/0x44`) carrying
  state: lock LEDs, battery, RF, GIF selection, test colour, keycodes, layer, USB mode. The screen chip draws its
  own widgets (it runs LVGL). No pixel data crosses this link **[inferred from header]**.
- Screen MCU control pins on the keyboard MCU: `LVGL_RESET_IO A5`, `LVGL_BOOT_IO A6`, `LVGL_POWER_IO A8`.
  Keycodes `LVGL_BOOT`, `LVGL_RESET_BOOT`, `LVGL_NEXT/PREV/ENT`, `QMK_TEST_COLOUR` exist **[source]**. So the
  keyboard can put the screen chip into its bootloader, which is a possible route to dumping/reflashing it.
- Epomaker Hub names the screen commands: 10 FUNC_START, 11 FUNC_STOP, 12 READ_INFO, 13 WRITE_INFO (never
  used by any tool), 14 READ_FUNC, 15 WRITE_FUNC, 16 WRITE_FUNC_OK, 17 WRITE_TIME, 18 FLASH_ERASE,
  19 FLASH_WRITE, 1A INIT_LCD, 1B WRITE_START, 1C GET_MODE **[Hub JS]**.
- No live framebuffer/draw command exists in any published tool, source or the RT82 research **[searched]**.

## First GIF upload (2026-10-21)

- `pnpm qk108 draw-test` uploaded a 1-frame test pattern in 2.3 s (table write 104 ms, erase 742 ms incl. 500 ms
  fixed wait, 301 packets in 886 ms, finish 526 ms). Slot table afterwards: `00 01 01 | 00 00 c8 41 00`
  **[verified]**. After switching to the GIF page (Fn + Right Shift), the screen showed the test pattern correctly: bars,
  white square top-left, black diagonal **[verified, by eye]**. Our QGIF encoder + uploader work end to end.
- Screen page keys (Epomaker source, `keymaps/via/keymap.c`): Fn + Right Shift = `L_GIFCH`, Fn + Enter = `L_LOOP`,
  Fn + Left Ctrl = `TEST_CL`, top-row key left of the knob = `L_SHUT`. The knob is volume **[source]**.

## Flipbook: live frame switching via the slot table (2026-10-21)

- Uploaded 4 one-frame GIFs (red/green/blue/yellow, 1 block each, 7.3 s), then re-pointed ALL slots at one
  frame at a time with table-only writes: `1B 38`, `15` x3, `16`, `1A`, `11` (no erase, no image write).
  **The screen redrew to the new frame on its own, while on the GIF page** **[verified, by eye]**.
- Each switch took ~140 ms (7 switches, 2.5 s apart, `1C` ping every 1 s in between) **[verified]**.
- The 8th switch froze the screen chip partway through the table write: no reply, then USB writes time out
  with ETIMEDOUT, while it stayed enumerated. The screen kept showing the last good frame (yellow) **[verified]**.
  Cause unknown. Candidates: missing settle delay after commit, or the minimal sequence (no `14` read / `E3` /
  time sync) leaving state that builds up.
- The screen drops off USB after ~4 s with no traffic, even right after an upload, so waits must keep pinging
  **[verified]**.
- Stress test 2026-10-22: "full" mode at 1 switch/s froze on switch #14, on the `16` commit (no reply, then
  no reply to a ping with an 8 s timeout either). It is a freeze, not a slow commit **[verified]**.
- Between frames the screen briefly shows a "Downloading" screen most of the time **[verified, by eye]**. Both
  minimal and full switches enter download mode (`1B` WRITE_START) and re-init the LCD (`1A` INIT_LCD).
  Repeated LCD re-init is the leading suspect for the freeze after 8-14 switches **[inferred]**.
- Next: a `func` mode that sends the table inside a plain `10`/`11` FUNC session (Hub names: 14 READ_FUNC,
  15 WRITE_FUNC, 16 WRITE_FUNC_OK), with no `1B`/`1A` **[untested]**.
- Unplugging USB doesn't seem to reset a frozen screen chip (the keyboard has a battery). Use the screen on/off
  key or the keyboard's power switch **[inferred]**.

## Stable live flipbook: "flip" mode (2026-10-22)

- `func` mode (`10`, `15` x3, `16`, `11`) passed 150 switches with no freeze (109 ms each, up to 9.2/s), but the
  **screen never redraws**: the table changes silently, even across a USB drop-off **[verified, by eye]**.
- Redraw trigger test, after a `func` switch each time: `14` READ_FUNC → no redraw; `1A` INIT_LCD alone → redraw;
  `1B` + `1A` → redraw. No "Downloading" screen appeared without `1B` **[verified, by eye]**.
- **flip = `func` switch + `1A`**: 150 switches, 0 failures, 140 ms each, up to 7.1 switches/s back-to-back. The
  chip still responds afterwards **[verified]**. The screen redrew on every switch, getting faster through the
  phases, with no "Downloading" screen **[verified, by eye]**. The earlier freezes came from entering download mode (`1B`)
  over and over, not from `1A` **[inferred: same 150-switch test, only difference is no `1B`]**.

## Typing meter (2026-10-22)

- `pnpm qk108 meter`: 13 one-frame levels + a 36-frame, 20 fps explosion QGIF (228 KB), 17 blocks in all, uploaded in
  36.5 s with one visible slot. Images beyond the visible slots are stored and reached by re-pointing slot 1
  **[verified]**.
- Flipping to an animated GIF plays it on screen; the explosion looked right in the demo **[verified, by eye]**.
- The flash erase (`18`) can take longer than 1 s to reply for many blocks: a 13-block erase timed out at 1 s,
  so the uploader now allows ~1 s per block **[verified]**.

## Writing new frames without a full upload (2026-10-22)

- Upload with spare blocks: set the table's total-block count and the `18` erase count to images + spares. The
  spares are erased and left empty **[verified: 17 used + 8 spare = 25 allocated]**.
- `19` FLASH_WRITE into an erased spare block works **outside download mode**: with no session (cyan, block 17)
  and inside a plain `10`/`11` session (magenta, block 18). Each 16,840 B frame took ~0.9 s, and both displayed
  correctly after a flip **[verified, by eye]**.
- `19` inside a download session (`1B` then `19`) hung the screen chip on the first write packet **[verified]**.
  So outside the full upload, never use `1B`.
- Flash can only be written once per erase, so each spare block can be used once until the next full upload.

## Live clock (2026-10-22)

- `pnpm qk108 meter` shows a clock when idle. Each minute's face (2-frame QGIF, blinking colon, 17,223 B) is written
  into the next spare block ~6 s before the minute (~1 s per write), then flipped to when the minute turns.
- Run with a 60-block pool: upload took 74 s (77 blocks allocated); faces for 12:34/12:35/12:36 were written to blocks
  76/75/74 with no errors or disconnects **[verified]**. The clock showed and changed **[verified, by eye]**; whether
  it changes exactly on the minute was not timed **[unverified]**.
- The first face is written to the LAST spare block (76, ~4.9 MB into flash) and displayed, so the flash holds at
  least 77 blocks **[verified, by eye]**.
- When the pool runs out (~1 hour), everything is re-uploaded with a fresh pool, about 74 s of "Downloading".

## Erasing without a full upload (2026-10-22)

- `18` erase with no download session (no `1B`) got no reply and hung the screen chip. It reconnected to USB but
  answered nothing until a full power cycle: USB unplugged and the power switch off ~10 s. The screen key alone
  did not reset it **[verified]**.
- `18` inside a short download session (`1B`, `14`, table `15`x3 + `16`, `18`, `1A`, `11`, no image writes)
  works: 1.6 s in download mode, a brief "Downloading" flash, and the erase reply after ~1.3 s **[verified]**.
- **The erase ignores its count and wipes every block the slot table says is allocated.** Requesting 4 blocks
  with the table allocating 21 erased all 21: meter frames at blocks 4-20 turned white **[verified, by eye]**.
  This matches open-keyboard-lcd's trial, where allocation 1 + erase request 7 left blocks 3 and 6 intact.
- Erased flash displays as **white** (0xFFFF). After a page switch (Fn + Enter) the GIF page showed **black** for
  a slot pointing at erased flash **[verified, by eye]**.
- **Scoped erase works:** write the table with an allocation of just the scratch blocks (slot → block 0,
  total = 4) inside the short download session, erase, then restore the real table with a `flip`. Blocks 0-3
  were erased (a fresh frame written over old data came out clean) and the erase replied in ~372 ms, versus
  ~1.3 s for 21 blocks. Total ~0.83 s, under half a second of it in download mode. Two clean runs **[verified]**.
  The meter frames at blocks 4-20 (full, half, empty bars) displayed intact afterwards, and the screen matched the
  expected-screens sheet **[verified, by eye]**.
- A hang in one run was **Chrome interfering**: a Hub/web-tool tab held the keyboard's vendor channel and woke the
  screen on its own. After quitting Chrome the chip answered with no power cycle **[verified]**. Close those tabs
  before running anything.

## Epomaker Hub /oled analysis (2026-10-22, static, bundle `index-lRdp-yeI.js`)

- Hub lists the QK108 (36b0:30af) as an "lcd"-kind OLED device: 240x135, 3 layers, max 40 frames, frame delay
  20-1000 ms. It uses the same code as RT82/RT98/TH108 V2 PM **[Hub JS]**.
- No live framebuffer, pixel streaming, text or system-monitor path for this screen. Text and drawings are
  rendered in the browser and uploaded as QGIF. The TFT commands (`0x25` etc.) are for other vendors' boards **[Hub JS]**.
- Hub defines but never sends `12` READ_INFO, `13` WRITE_INFO, `1C` GET_MODE. Nothing selects a slot, sets
  brightness or rotation, or switches page from the host **[Hub JS]**.
- Activation: keyboard `AA E2` once, then `AA E0` x5, then poll for 1919 **[Hub JS]**.
- **Erase takes a start block**: Hub's single-slot upload sends `AA 18 <start lo> <start hi> 00 01 00 00 [n]`,
  logging "erase Flash offset=start (n x 64K)". Batch upload sends `AA 18 00 00 00 01 00 00 [total+1]`. Both send
  the erase without waiting for a reply and then sleep 500 ms x n **[Hub JS, verified by reading]**. Untested on
  our keyboard. It could allow erasing a region that doesn't start at block 0.

## Live streaming: the screen as a slow second monitor (2026-10-22)

- Method (`src/stream.ts`, `FrameStreamer`): write a QGIF header (65535 frames, 8 fps) + keyframe into an erased
  region, flip to it, then keep appending frame records ~1 s ahead of the playhead with bare `19` writes. Frames with
  no new content are "nothing changed" records (255 B bitmap). No download mode while streaming.
- `stream-test`: 359 random numbers, generated live with `Math.random()` just before each write, shown over 46 s
  (7.8 new frames/s at 8 fps, 0 filler frames). Each was ~100-190 changed tiles, 1.1-1.8 KB, written in 60-100 ms.
  675 KB of a 1 MB region used. The screen showed random numbers changing quickly throughout, then the rest frame
  **[verified, by eye]**. So the player reads frames from flash as it plays, not up front.
- Latency is the lead (8 frames = 1 s). Throughput is bounded by USB writes, ~18 KB/s, so a fully changed frame
  (16.6 KB) takes ~0.9 s.

## Erasing with NO download mode (2026-10-22)

- **`18` works inside the plain FUNC session**: `10`, table write (`15` x3 + `16`) with allocation = blocks to
  erase, `18`, `11`, then restore the real table with a func (or flip) table write. Erasing block 0 replied in
  179 ms (status 0x00). A fresh red frame written there afterwards was clean, the meter frames at blocks 16+ were
  intact, and **no "Downloading" screen appeared** at any point **[verified, by eye]** (`Screen.funcErase`,
  `func-erase-test`).
- Compare: `18` with no session at all hangs the chip, and `18` inside `1B` shows "Downloading".
- Still from block 0 up (the erase follows the table allocation). Whether Hub's start-block form
  (`AA 18 <start lo> <start hi> 00 01 00 00 [n]`) erases a region that doesn't start at block 0 is **untested**.
- **Start-block erase does NOT work on the QK108** (`start-erase-test`): plain-session erase with start = 8 (bytes
  2-3, Hub's form), count 1, table allocation 12. Afterwards blocks 0, 9 and 11 showed white (erased), block 8
  took a clean new frame, and the meter frames (blocks 16+) were intact. The erase replied in 1,260 ms
  **[verified, by eye]**. So the erase always clears blocks **0 .. allocation-1**, ignoring both the start
  bytes and the count.
- **No flash read**: `14` READ_FUNC at address 0x100000 (where a known QGIF is stored) got no reply and froze the
  screen chip; only a power cycle helps. Reads at address 0 return the table **[verified]**. `12` at other
  addresses: untested.
- **Table header byte 0 does not move the erase start** (dashboard `header-start-erase`): header byte 0 = 8,
  allocation 2. Block 0 came out white (erased), block 8 was NOT erased (a new frame over old data showed artifacts),
  blocks 10/11 intact, erase 231 ms **[verified, by eye]**. Conclusion: erase clears blocks 0..allocation-1, period.

## Rotation (dashboard `stream-rotate`, 2026-10-22)

- LiveScreen v1 (stream area 2 blocks, 3 parking blocks, WAIT fallback): 60 s of random numbers, 202 frames, 7 rotations
  (6 parked + 1 WAIT). Erases of the stream area took ~0.3 s, a full 5-block erase 0.8 s. Never white, Downloading
  or garbled **[verified, by eye]**. Each rotation froze updates ~3.2 s: writing the parking still and the new
  keyframe (~0.9 s each) plus flips.
- Seamless rotation v2 (dashboard `stream-seamless`, parking _streams_, background prep): software never starved
  (5 rotations in 61 s, max 5 frames behind), but on screen it **froze ~2 s a few times and stuttered**
  **[verified, by eye]**. Causes: each switch restarts on a keyframe ~1 s old plus a 1 s buffer of empty frames,
  and USB is ~80% busy with 8 fps random numbers, so the extra 17 KB keyframes crowd out content (3.8 content frames/s).
- Writes so far wait for each packet's reply (~3 ms, ~18 KB/s). Next: pipelined writes (`fast-writes`).

## Pipelined writes (dashboard `fast-writes`, 2026-10-22)

- Keeping several `19` FLASH_WRITE packets in flight before reading replies works and is clean: a 16,840 B frame took
  910 ms with 1 in flight (18.5 KB/s) and 304 ms with 4, 8 or 16 in flight (55 KB/s). All four letters displayed
  correctly **[verified, by eye]**. 8 and 16 are no faster, so the ceiling is USB's ~1 packet/ms. `Screen.writeWindow`
  sets the default; LiveScreen uses 4.
- Seamless v3 run (4 in flight, 0.5 s buffer, 8 parking): 390 numbers in 60 s (6.5/s), 9 seamless + 1 WAIT rotations,
  never starved. On screen: better, but a 0.5-1 s freeze about every 4 s, and a WAIT at ~50 s when parking ran out
  **[verified, by eye]**. Cause: each new stream started with a full buffer of "no change" frames.
- Fixes (simulated, not yet on device): switch with a fresh latest-content frame + 1 padding frame; before an erase,
  pad only max(lead, erase time); write content whenever it's waiting; rotate early while content is idle. Simulated
  worst content gap under nonstop changes: 375 ms (floor: the ~300 ms erase blocks USB).
- **Seamless v4 on device: passed** (dashboard `stream-seamless`, 2-block stream area, 13 parking): 403 numbers in
  60 s (6.7/s), 10 rotations, 0 WAIT. The user saw "short (less than half second) freezes every 5 s or so"
  **[verified, by eye]**. The logged content gaps around each erase were 375-625 ms. In real use (14+ block stream
  area) rotations are ~7x rarer, and they happen early during idle moments when possible.

## Real display delay (2026-10-22)

- Drawing pad (dashboard `draw-pad`): with software buffers of 1 s, 0.5 s and 0.25 s, the user saw the same ~2 s delay
  every time **[verified, by eye]**. The log showed 8.0 frames/s written, no rotations and buffers as set, so the
  screen adds ~1.5-2 s of its own. Leading guess: playback of frame 0 starts well after the switch (`1A`) returns,
  so our playhead estimate runs early. Being measured with `lag-meter`.
- **Lag meter at 8 fps** (dashboard `lag-meter-8fps`, 0.25 s software buffer): the keyboard was ~5 counts (1.25 s)
  behind at the start and ~12 (3 s) at the end of 45 s **[verified, by eye, approximate]**. So the lag grows ~4%:
  the screen plays slower than the declared 8 fps. That fits 125 ms frames rounded to 130 ms (10 ms ticks)
  **[hypothesis]**. Plus a ~1 s start-up delay after a switch. Next: 10 fps (100 ms, no rounding) to check drift.
- **Lag meter at 10 fps** (`lag-meter-10fps`, 0.3 s buffer): ~4 counts (1.0 s) behind at the start, ~6 at the end of
  45 s **[verified, by eye, approximate]**. Drift is down to ~1% (near reading precision), and the start-up delay after
  a switch is ~0.7 s. LiveScreen now takes `startDelayMs` to correct for it; testing 600 ms over 2.5 min.
- **Start-up correction failed** (`lag-meter`, 10 fps, 0.3 s buffer, `startDelayMs` 600): the screen went white
  immediately, then garbled, until stopped **[verified, by eye]**. It read flash we hadn't written yet. So the extra
  ~0.7 s is **read-ahead**, not a late start: the screen needs frames written well before they're due on screen.
  Don't use `startDelayMs` > 0 until read-ahead is understood. Open question: is the read-ahead a fixed time, or a fixed
  number of bytes (e.g. a 4 KB flash page)? If bytes, bigger filler frames would cut the delay.
- **Padding filler frames helps** (`readahead-pad`, 10 fps, 0.3 s buffer): normal tiny frames were 4 then 5 counts
  behind (~1-1.25 s, creeping); every frame padded to 1.5 KB (identical picture) was 3 then 3 (~0.75 s, steady)
  **[verified, by eye]**. So the read-ahead is at least partly byte-based. Next: a sweep at 1.5/3/5 KB.
- **Reaction test v1** (`reaction-latency-v1`, 10 fps, 0.3 s buffer, typical 250 ms reaction subtracted): no padding
  gave a **median real delay of ~660 ms** (4/4 trials: 326, 560, 660, 720 ms) **[verified, clicks]**. The padded phase
  started after a WAIT that looked like the end, so it went unclicked. Then the 1-block parking stream overflowed with
  padding, the test crashed mid-stream, and the screen showed garbage, then white. Fixed: parking/near-full streams
  never pad, and the test uses one stream with `setPad()` between rounds (no WAIT).
- **Reaction test v2** (`reaction-latency`, one stream, 10 fps, 0.3 s buffer, 250 ms reaction subtracted) **[verified, clicks]**:
  - no padding: 437, 483, 580, 583 ms, median **~580 ms**
  - 1.5 KB padding: 687, 823, 925, 957 ms, median ~925 ms
  - 3 KB padding: 1945 (mid-recycle), 488, 521 (right after a fresh stream), 843 ms
    **Padding makes it worse.** The delay creeps up within a stream and drops back to ~0.5 s on a fresh one: playback
    runs a bit slower than 10 fps (~1% with plain frames, more with padded ones). The floor is ~0.45-0.5 s. LiveScreen
    defaults are now 10 fps, 3-frame buffer, no padding.
- Using the **fastest click** per setting (least affected by reaction time) instead of the median: no padding =
  **~0.33-0.44 s** real delay (fastest clicks 576 / 687 ms after send, minus ~250 ms reaction); 1.5 KB = ~0.69 s;
  3 KB = ~0.49 s (right after a fresh stream). Reaction tests now report best and median.

## Screen server live on the keyboard (2026-10-23)

- `bun run screen` (localhost:4110): first start ran the one-time flash setup (48 managed blocks + WAIT/DONE/BLANK,
  34 s of Downloading), then streamed Clock mode from 10:00:43. The user confirmed **the clock with live seconds on the
  keyboard** **[verified, by eye]**. Modes: draw, key ticker, clock, system monitor, Life, starfield, message, image.
  API: POST /text, POST /image, WS /ws, GET /frame.png. All modes were checked first against `FAKE_SCREEN=1`.

## Long erases drop the screen off USB, and once froze it (2026-10-24)

- With System Monitor on (new content every second), every rotation erased a full 40-block main area. Those erases
  took **5.3-5.6 s**; yesterday's half-full (idle Clock) erases took ~3.9 s and right after setup 48 blank blocks took
  2.7 s **[verified, server log]**. Fit: ~56 ms per blank block + ~137 ms per block holding data.
- Of 37 rotations that day, **6 dropped the screen off USB** right after the erase (`11` failed with EPROTO, once `18`
  with EIO). Each time the server found the erase's table (allocation 40), didn't recognise it, and redid the whole
  setup: 33 s of Downloading **[verified, server log]**.
- The 7th dropout (16:41) **froze the controller**: it re-appeared on USB after `AA E0` but never answered `14`, and the
  server retried every ~7 s for 2 hours. On screen: coloured noise **[verified, by eye]**.
- Tried while frozen **[verified, kernel log + by eye]**: `usbreset 1919:1919` (the kernel reset it twice, no answer,
  then it couldn't even send its device descriptor); the hub's port-1 `disable` off/on (the kernel's own port power
  cycle didn't help either: the keyboard MCU powers the chip, not the hub port); the screen-shutdown key (`L_SHUT`,
  top row left of the knob). None helped. After the power cycle the chip re-enumerated by itself (19:02:05) while the
  keyboard stayed on USB.
- Fix (`src/live.ts`, `src/layout.ts`, `src/service.ts`): main/parking split 24/24; a rotation erases only the blocks
  the old main stream used (≤ 24, ~3.3 s); big erases go in steps that each stay under 3.5 s, with a status ping
  between; a table left by an interrupted erase is recognised (no re-setup); after 3 failed connects the server stops,
  shows "power-cycle the keyboard", and resumes when the chip or keyboard re-enumerates.

## Freezes during plain streaming; gentler writes, watchdog, sleep mode (2026-10-25)

- With the short-erase fix, 28 rotations overnight all took 3.1-3.2 s **[verified, server log]**. But at 23:39:42 the
  chip dropped off USB **during ordinary streaming** (no erase running; a `19` write failed with EPROTO), re-appeared
  3 s later, and never answered `14` again: noise on screen. The server's new frozen detection caught it.
- Looking back, 2026-10-23 had a silent one: the last rotation was 13:17, then nothing for 22 h (no errors, the chip
  stayed on USB) until the keyboard was power-cycled. The server had no way to notice.
- Both happened with 4 `19` writes in flight. Now 2 (~37 KB/s; every mode needs ≤ 31 KB/s, measured by encoding each
  mode's frames: clock/sysmon ~6, draw ~10, stars ~14, Life ~25, ticker under fast typing ~30). Unproven as the cause.
- Stall watchdog: if no write or erase finishes for 10 s, the stream fails, so the service reconnects and reports a
  frozen chip.
- Sleep mode: when GNOME locks or blanks the screen (`org.gnome.ScreenSaver` ActiveChanged / GetActive), the server
  stops streaming, stores a short looping QGIF at block 0 (built-ins are 30-61 KB, one block) and lets go of USB; on
  unlock it reconnects and streams again. This also gives the chip long rests from constant writing.

## Noise while still answering USB (2026-10-25)

- Around 15:05 the screen showed coloured noise while the server kept streaming happily: no USB errors, every `19`
  write acknowledged (~10 frames/s), no disconnects in the kernel log. A server restart (fresh erase and stream) didn't
  help; a full power cycle did **[verified, by eye + logs]**. So the controller's USB side kept working while its
  display side was stuck: a new failure mode that the stall watchdog can't see.
- Only the keyscreen server had the HID nodes open. Just before, two library checks ran: `node-hid` listing devices
  (hidapi 0.15 enumerate, which reads sysfs and shouldn't open or write the device) and `uiohook-napi` under Node (X11
  hooks only). Neither should touch the screen, but the timing is close, so `node-hid` gets a careful on-device trial
  before it replaces `src/hidraw.ts`.
