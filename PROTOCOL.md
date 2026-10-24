# Epomaker QK108 screen: USB API and behavior

Specification of the QK108's screen controller as seen from a USB host. Verified on a QK108.
History, experiments and failures are in [LOG.md](LOG.md).

## 1. Devices

| Device            | USB ID      | Interface                                                                               |
| ----------------- | ----------- | --------------------------------------------------------------------------------------- |
| Keyboard          | `36b0:30af` | if1: HID, usage page `0xFF60`, usage `0x61`, 32-byte reports (VIA raw HID)              |
| Screen controller | `1919:1919` | if1: HID, usage page `0x00FF`, usage `0x01`, 64-byte input/output reports, no report ID |

- The screen controller sits behind a hub inside the keyboard. It is enumerated only on request:
  1. The host sends `AA E0` to the keyboard. The controller appears about 1.5 s later.
  2. While it is absent, `E0` may be repeated, e.g. every 400 ms.
- The controller leaves the bus after about **4 s with no commands**. Any command resets the timer.
- The controller accepts one host. Two hosts sending commands at once can leave it unresponsive.

## 2. Reports

### Keyboard (32 bytes)

`AA cmd` followed by parameters, payload from byte 8. The reply echoes `AA cmd`.

### Screen controller (64 bytes)

```
byte  0    1    2      3      4      5    6  7   8 .. 63
      AA   cmd  addrL  addrM  addrH  len  00 00  payload (up to 56 bytes)
```

- `addr`: 24-bit little-endian. A byte address for flash writes; a page offset for table writes.
- `len`: payload length.
- Every command produces one 64-byte reply echoing `AA cmd`. Reply byte 7 = `0x0F` means the command was rejected.
- Flash writes (`19`) may be pipelined: the host may send several before reading their replies. Replies arrive in
  order. Throughput is ~55 KB/s with 4 or more in flight (about one packet per millisecond), ~18 KB/s with one.

## 3. Keyboard commands

| Command | Parameters          | Effect                                                      |
| ------- | ------------------- | ----------------------------------------------------------- |
| `E0`    | none                | Enumerate the screen controller on USB                      |
| `E2`    | none                | Screen mode status. Reply byte 8 = 1 means on               |
| `E3`    | `len 1`, byte 8 = n | Set the number of stored screens; sent before a full upload |

## 4. Screen controller commands

| Cmd  | Name          | Parameters                                | Effect                                                                          |
| ---- | ------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| `10` | FUNC_START    | none                                      | Opens a plain session                                                           |
| `11` | FUNC_STOP     | none                                      | Closes a session                                                                |
| `12` | READ_INFO     | `len 0x38`, in a plain session            | Reply: width u16LE at 20, height u16LE at 22, rotation at 26 (240, 135, 0)      |
| `14` | READ_FUNC     | `addr 0, len 0x38`                        | Reply payload (from byte 8) = slot table                                        |
| `15` | WRITE_FUNC    | table page (see §5)                       | Writes a slot table page                                                        |
| `16` | WRITE_FUNC_OK | `len 0x38`                                | Commits the slot table                                                          |
| `17` | WRITE_TIME    | `len 0x38`, in a plain session (see §6.1) | Sets the clock                                                                  |
| `18` | FLASH_ERASE   | `len 1`, 1 payload byte; inside a session | Erases flash blocks `0 .. allocation-1` (see §5). Replies when done             |
| `19` | FLASH_WRITE   | `addr`, `len` ≤ 56, data                  | Programs bytes into erased flash. No session needed                             |
| `1A` | INIT_LCD      | none                                      | Re-reads the slot table and restarts playback of slot 1 from its first frame    |
| `1B` | WRITE_START   | `len 0x38`                                | Enters download mode; the screen shows "Downloading" until `1A`                 |
| `1C` | GET_MODE      | none                                      | Status; reply byte 9: 0 Bluetooth, 1 2.4 GHz, 2 USB. Also serves as a keepalive |

## 5. Flash and slot table

- Flash is addressed in bytes and organised in 64 KiB **blocks**. At least 77 blocks are available.
- Erased flash reads as `FF`. Programming can only clear bits, so a region must be erased before it is rewritten.
- Images are stored as QGIF (§7), each starting on a block boundary.
- The **slot table** says what the screen plays:
  ```
  00  count  allocation   then for each slot:  startBlock 00 lenL lenM lenH
  ```
  - `startBlock`: first block of the image; `len`: image size in bytes (24-bit).
  - `allocation`: number of blocks in use. **`18` erases exactly blocks 0 .. allocation-1.** Its payload byte and
    address bytes are ignored.
  - Writing a table: `15 addr 0 len 0x38` (table), `15 addr 0x38 len 0x38` (zeros), `15 addr 0x70 len 0x10`
    (zeros), then `16 len 0x38`.
- The screen plays **slot 1** on its GIF page. A table change takes effect on the next `1A`.

## 6. Sequences

### 6.1 Set the clock

`10` → `17 len 0x38` → `11`. The `17` payload is one decimal digit per byte:

```
Y Y Y Y  M M  W  D D  h h  m m  s s      (W = weekday, Sunday = 0)
```

### 6.2 Full upload (download mode)

1. Keyboard `E3` with the slot count.
2. `1B`, then `14`.
3. Write the slot table, with `allocation` covering every block to be erased.
4. `18`. Its reply arrives after the erase: ~56 ms per already-blank block, ~137 ms per block that holds data.
5. `19` writes for each image.
6. `1A`, then set the clock (§6.1), then `11`.

The screen shows "Downloading" from `1B` until `1A`. Allocated blocks not written by the upload remain erased.

### 6.3 Change the displayed image

`10` → write the slot table (slot 1 → any image stored in flash) → `11` → `1A`.
Takes ~140 ms. No "Downloading" screen. Repeatable indefinitely.

### 6.4 Erase without download mode

`10` → write the slot table with `allocation = N` (slot 1 pointing inside 0..N-1) → `18` → `11`.
Blocks 0..N-1 are erased with no "Downloading" screen and no display change. A table write without `1A` can then
restore the previous table without affecting the display.

### 6.5 Programming erased flash

`19` writes at any byte address inside erased blocks, in any session state (or none), while the screen keeps
playing. Writes become visible to playback immediately.

## 7. QGIF format

### Header (10 bytes)

| Bytes | Meaning                                        |
| ----- | ---------------------------------------------- |
| 0–3   | `QGIF`                                         |
| 4     | 0                                              |
| 5     | 2 × fps − 1 (fps 1–128)                        |
| 6–7   | frame count, big-endian                        |
| 8     | width / 4 − 1                                  |
| 9     | height / 4 − 1 (the 135-pixel screen uses 136) |

### Frame records

- Each frame record is:
  1. A change bitmap: one bit per 4×4 tile, tiles left-to-right then top-to-bottom, MSB first.
     `ceil(tiles / 8)` bytes; 255 bytes for 240×136.
  2. 8 bytes for each set bit, in tile order.
- The first record must include every tile. A record with an all-zero bitmap repeats the previous frame.
- After the last frame, a looping animation has one extra record that restores the first frame. It isn't counted
  in the header.

### Tile (8 bytes)

| Bytes | Meaning                                                       |
| ----- | ------------------------------------------------------------- |
| 0–1   | colour A, RGB565 little-endian                                |
| 2–3   | colour B, RGB565 little-endian                                |
| 4–7   | 4 rows of four 2-bit indices, leftmost pixel in the high bits |

Palette: 0 = A, 1 = B, 2 = (2A+B)/3, 3 = (A+2B)/3, with A > B.

## 8. Playback behavior

- Playback reads frame records from flash progressively while it plays, not up front. Records appended to an
  image's flash region while it plays are played in turn.
- Playback reads ahead of the frame on screen. A record must be in flash ~0.3 s or more (≥ 3 frames at 10 fps)
  before it is due. A record read before it is written shows as garbage, and erased flash shows as **white**.
- Actual frame timing is slightly slower than declared:
  - ~1% at 10 fps (100 ms frames)
  - ~4% at 8 fps (125 ms frames)
  - more for larger records
- Larger records lengthen the display delay. Padding records with unchanged tiles makes it worse, not better.
- Updating content by appending to a playing image gives a display delay of ~0.35–0.45 s, at 10 fps with records
  written 3 frames ahead.

## 9. Controller states to avoid

The controller stops answering (it stays on USB, but sends no replies) after:

- `18` sent outside a session
- `19` sent inside a download-mode session (`1B`)
- `1B` … `1A` repeated many times in quick succession (for example, every 2.5 s)
- `14` at a nonzero address
- an `18` erase that runs longer than ~5 s (about 40 blocks that hold data). The controller can't answer USB while
  erasing; after a long erase it usually drops off USB and comes back when woken (the table is left as the erase
  wrote it), and once it froze. Erases of up to ~4 s never caused this. Keep each erase short: erase only blocks
  that hold data, or erase in steps (`allocation` 25, then 39, …), since re-erasing blank blocks is cheap.

It also stops answering when another host sends commands at the same time. If that host closes, the controller
recovers without a power cycle.

Otherwise it recovers only after a full power cycle: USB unplugged and the keyboard's power switch off for ~10 s.
The keyboard's battery keeps it powered while only unplugged. A frozen controller does not recover from a USB port
reset (`usbreset`), from switching the hub port's power off and on, or from the keyboard's screen-shutdown key.
After the power cycle it re-enumerates by itself for ~1 s, even if the keyboard itself stayed on USB.

## 10. Keyboard-side behavior

- Screen page keys:
  - Fn + Right Shift: GIF page (plays slot 1)
  - Fn + Enter: cycle pages
  - the key left of the knob: screen on/off
- The Caps Lock and Num Lock icons follow the host's keyboard LED output report (bit 0 Num, bit 1 Caps). An LED
  report sent to the keyboard's boot interface (if0, report `[0x00, bits]`) updates them immediately.
