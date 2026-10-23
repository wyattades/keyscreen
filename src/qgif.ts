// QGIF: the screen's flash image format (spec: PROTOCOL.md section 7).
//
// Header (10 bytes): "QGIF", 0, 2*fps-1, frameCount (u16 BE), width/4-1, height/4-1.
// Then one record per frame plus a final record that restores frame 0. Each record is
// a change bitmap (1 bit per 4x4 block, MSB first) followed by 8 bytes for every changed block:
// RGB565 endpoint A (LE), endpoint B (LE), then 4 rows of 2-bit palette indices, MSB pair = leftmost.
// Palette: A, B, (2A+B)/3, (A+2B)/3.

export interface Frame {
  /** RGBA, width*height*4 bytes. */
  rgba: Uint8Array;
}

const rgb565 = (r: number, g: number, b: number) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
const expand = (c: number): [number, number, number] => {
  const r = (c >> 11) & 31,
    g = (c >> 5) & 63,
    b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
};

function palette(a: number, b: number): [number, number, number][] {
  const A = expand(a),
    B = expand(b);
  const mix = (x: number[], y: number[]) => x.map((v, i) => Math.round((2 * v + y[i]) / 3)) as [number, number, number];
  return [A, B, mix(A, B), mix(B, A)];
}

const dist2 = (p: ArrayLike<number>, q: ArrayLike<number>) =>
  (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/** Encodes one 4x4 block (16 RGB pixels, row-major) to 8 bytes. */
function encodeBlock(px: [number, number, number][]): Uint8Array {
  // Endpoints: the two most distant colors in the block.
  let best = -1,
    ia = 0,
    ib = 0;
  for (let i = 0; i < 16; i++) {
    for (let j = i + 1; j < 16; j++) {
      const d = dist2(px[i], px[j]);
      if (d > best) [best, ia, ib] = [d, i, j];
    }
  }
  let a = rgb565(...px[ia]),
    b = rgb565(...px[ib]);
  // Keep A > B (DXT1's 4-color mode) in case the firmware cares about endpoint order.
  if (a < b) [a, b] = [b, a];
  const pal = palette(a, b);
  const out = new Uint8Array(8);
  out[0] = a & 0xff;
  out[1] = a >> 8;
  out[2] = b & 0xff;
  out[3] = b >> 8;
  for (let row = 0; row < 4; row++) {
    let byte = 0;
    for (let col = 0; col < 4; col++) {
      const p = px[row * 4 + col];
      let idx = 0,
        bd = Infinity;
      if (a !== b) {
        for (let k = 0; k < 4; k++) {
          const d = dist2(p, pal[k]);
          if (d < bd) [bd, idx] = [d, k];
        }
      }
      byte |= idx << (6 - col * 2);
    }
    out[4 + row] = byte;
  }
  return out;
}

/** Splits an RGBA frame into encoded 4x4 blocks (left-to-right, top-to-bottom). */
function encodeBlocks(rgba: Uint8Array, w: number, h: number): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let by = 0; by < h; by += 4) {
    for (let bx = 0; bx < w; bx += 4) {
      const px: [number, number, number][] = [];
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const o = ((by + y) * w + bx + x) * 4;
          px.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
        }
      }
      blocks.push(encodeBlock(px));
    }
  }
  return blocks;
}

const sameBlock = (p: Uint8Array, q: Uint8Array) => p.every((v, i) => v === q[i]);

export function encodeQgif(frames: Frame[], opts: { width: number; height: number; fps?: number }): Uint8Array {
  const { width: w, height: h, fps = 10 } = opts;
  if (w % 4 || h % 4) throw new Error("QGIF dimensions must be multiples of 4");
  if (!frames.length || frames.length > 65535) throw new Error("need 1-65535 frames");
  if (fps < 1 || fps > 128) throw new Error("fps must be 1-128");
  const encoded = frames.map((f) => {
    if (f.rgba.length !== w * h * 4) throw new Error(`frame must be ${w}x${h} RGBA`);
    return encodeBlocks(f.rgba, w, h);
  });
  const n = encoded[0].length;
  const bitmapLen = Math.ceil(n / 8);
  const parts: Uint8Array[] = [
    Uint8Array.of(
      0x51,
      0x47,
      0x49,
      0x46,
      0,
      2 * fps - 1,
      frames.length >> 8,
      frames.length & 0xff,
      w / 4 - 1,
      h / 4 - 1,
    ),
  ];

  const record = (prev: Uint8Array[] | undefined, cur: Uint8Array[]) => {
    const bitmap = new Uint8Array(bitmapLen);
    const changed: Uint8Array[] = [];
    cur.forEach((blk, i) => {
      if (!prev || !sameBlock(prev[i], blk)) {
        bitmap[i >> 3] |= 0x80 >> (i & 7);
        changed.push(blk);
      }
    });
    parts.push(bitmap, ...changed);
  };

  let prev: Uint8Array[] | undefined;
  for (const cur of encoded) {
    record(prev, cur);
    prev = cur;
  }
  record(prev, encoded[0]); // restore the first frame for looping
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Decodes a QGIF to RGBA frames (for testing the encoder). */
export function decodeQgif(q: Uint8Array): { width: number; height: number; fps: number; frames: Uint8Array[] } {
  if (String.fromCharCode(...q.subarray(0, 4)) !== "QGIF") throw new Error("not a QGIF");
  const fps = (q[5] + 1) / 2,
    count = (q[6] << 8) | q[7],
    w = (q[8] + 1) * 4,
    h = (q[9] + 1) * 4;
  const bw = w / 4,
    n = bw * (h / 4),
    bitmapLen = Math.ceil(n / 8);
  const blocks: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(8));
  const frames: Uint8Array[] = [];
  let off = 10;
  for (let f = 0; f < count; f++) {
    const bitmap = q.subarray(off, off + bitmapLen);
    off += bitmapLen;
    for (let i = 0; i < n; i++) {
      if (bitmap[i >> 3] & (0x80 >> (i & 7))) {
        blocks[i] = q.slice(off, off + 8);
        off += 8;
      }
    }
    const rgba = new Uint8Array(w * h * 4);
    blocks.forEach((blk, i) => {
      const a = blk[0] | (blk[1] << 8),
        b = blk[2] | (blk[3] << 8),
        pal = palette(a, b);
      const bx = (i % bw) * 4,
        by = Math.floor(i / bw) * 4;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const c = pal[(blk[4 + y] >> (6 - x * 2)) & 3];
          rgba.set([...c, 255], ((by + y) * w + bx + x) * 4);
        }
      }
    });
    frames.push(rgba);
  }
  return { width: w, height: h, fps, frames };
}

/**
 * Incremental QGIF writer for streaming: emits the header once, then one record per frame
 * (the first is a full keyframe, later ones hold only changed blocks). There is no closing
 * "restore" record: a stream is never played to its end.
 */
export class QgifStream {
  readonly width: number;
  readonly height: number;
  private prev: Uint8Array[] | undefined;
  private bitmapLen: number;
  framesEncoded = 0;

  constructor(width: number, height: number) {
    if (width % 4 || height % 4) throw new Error("QGIF dimensions must be multiples of 4");
    this.width = width;
    this.height = height;
    this.bitmapLen = Math.ceil(((width / 4) * height) / 4 / 8);
  }

  /** 10-byte header declaring `frameCount` frames at `fps`. */
  header(frameCount: number, fps: number): Uint8Array {
    if (fps < 1 || fps > 128) throw new Error("fps must be 1-128");
    if (frameCount < 1 || frameCount > 65535) throw new Error("frameCount must be 1-65535");
    return Uint8Array.of(
      0x51,
      0x47,
      0x49,
      0x46,
      0,
      2 * fps - 1,
      frameCount >> 8,
      frameCount & 0xff,
      this.width / 4 - 1,
      this.height / 4 - 1,
    );
  }

  private padCursor = 0;

  /**
   * A record where nothing visibly changes. With `minBytes`, some unchanged blocks are re-sent
   * (same pixels) so the record is at least that big; the picture stays identical.
   */
  empty(minBytes = 0): Uint8Array {
    this.framesEncoded++;
    if (!this.prev || minBytes <= this.bitmapLen) return new Uint8Array(this.bitmapLen);
    return this.record(this.prev, new Set(), minBytes);
  }

  /**
   * Encodes the next frame's record. Returns the bytes and how many 4x4 blocks really changed.
   * With `minBytes`, unchanged blocks are re-sent until the record is at least that big.
   */
  next(rgba: Uint8Array, minBytes = 0): { bytes: Uint8Array; changed: number } {
    if (rgba.length !== this.width * this.height * 4)
      throw new Error(`frame must be ${this.width}x${this.height} RGBA`);
    const cur = encodeBlocks(rgba, this.width, this.height);
    const changed = new Set<number>();
    cur.forEach((blk, i) => {
      if (!this.prev || !sameBlock(this.prev[i], blk)) changed.add(i);
    });
    this.prev = cur;
    this.framesEncoded++;
    return { bytes: this.record(cur, changed, minBytes), changed: changed.size };
  }

  /** Builds a record sending `changed` blocks plus padding blocks (rotating through the frame). */
  private record(cur: Uint8Array[], changed: Set<number>, minBytes: number): Uint8Array {
    const send = new Set(changed);
    const n = cur.length;
    const want = Math.min(n, Math.ceil(Math.max(0, minBytes - this.bitmapLen) / 8));
    for (let k = 0; send.size < want && k < n; k++) {
      send.add(this.padCursor);
      this.padCursor = (this.padCursor + 1) % n;
    }
    const idx = [...send].sort((x, y) => x - y);
    const bytes = new Uint8Array(this.bitmapLen + idx.length * 8);
    for (const [j, i] of idx.entries()) {
      bytes[i >> 3] |= 0x80 >> (i & 7);
      bytes.set(cur[i], this.bitmapLen + j * 8);
    }
    return bytes;
  }
}
