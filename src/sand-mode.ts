// Sand mode: a falling-sand toy driven by the computer's mouse and the QK108's keys.
//
//   move the mouse    sand pours wherever the pointer is on the monitor (keeps trickling for a few
//                     seconds after it stops, then rests, so it doesn't flood while you type)
//   left click        next material: sand, water, stone, plant, fire
//   right click       blast a crater at the pointer
//   mouse wheel       pour size
//   typing            each key blasts a crater where that key sits on the keyboard (Q left, P right)
//   space             earthquake: the bottom rows drop away
//   enter             flush: the floor opens for a moment
// Past ~60% full the floor slowly leaks, so it never fills up for good.
//
// The pointer position comes from the keyscreen-pointer GNOME Shell extension when it's installed
// (exact, see src/pointer.ts); otherwise it's estimated from the mouse's raw movement, which drifts
// with GNOME's pointer acceleration. Without /dev/input access (the udev rule) at all, the
// dashboard's preview stands in as a pad.
import { Canvas, H, W } from "./canvas.ts";
import { watchInput, type Input } from "./input.ts";
import type { Mode, ModeContext } from "./modes.ts";
import { M, MATERIALS, SandWorld, SWATCH } from "./sand.ts";

const FRAME_MS = 100;
const STEPS_PER_FRAME = 3;
/** Keep pouring this long after the mouse stops. */
const TRICKLE_MS = 4000;
const LEAK_ABOVE = 0.6;

/** Keyboard rows, for placing a key's crater under where the key is. */
const ROWS = ["`1234567890-=", "QWERTYUIOP[]\\", "ASDFGHJKL;'", "ZXCVBNM,./"];
const ROW_OFFSET = [0, 0.04, 0.07, 0.1];

export class SandMode implements Mode {
  id = "sand";
  name = "Sand";
  blurb = "Sand pours wherever your mouse is. Click to change material, type to blast craters.";
  /**
   * Where the pointer position comes from: the GNOME extension (exact), the mouse's raw movement
   * (estimated), or the dashboard page (no /dev/input access).
   */
  get pointerSource(): "gnome" | "estimate" | "page" {
    const p = this.inputs?.source.pointer ?? "none";
    return p === "none" ? "page" : p;
  }
  private inputs: Input | undefined;
  private world = new SandWorld(W, H);
  private material = 0;
  private brush = 3;
  private pointer = { x: 0.5, y: 0.5, movedAt: 0 };
  private hudUntil = 0;
  private hudText = "";
  private flushUntil = 0;
  private timer?: ReturnType<typeof setInterval>;
  private frame = 0;

  start(ctx: ModeContext) {
    const input = watchInput({
      key: (ch) => this.key(ch),
      button: (b) => this.click(b),
      wheel: (n) => this.setBrush(this.brush + Math.sign(n)),
      pointerMoved: () => {
        this.pointer.x = input.pointer.x;
        this.pointer.y = input.pointer.y;
        this.pointer.movedAt = performance.now();
      },
    });
    this.inputs = input;
    this.flash(MATERIALS[this.material].name);
    this.timer = setInterval(() => this.tick(ctx), FRAME_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.inputs?.stop();
    this.inputs = undefined;
  }

  /**
   * From the dashboard: {type:"material", index}, {type:"size", n}, {type:"clear"}, {type:"key", key},
   * and, only when the computer's mouse can't be read, {type:"pointer", x, y} (0-1) and {type:"click", button}.
   */
  input(msg: Record<string, unknown>) {
    if (msg.type === "material" && typeof msg.index === "number" && MATERIALS[msg.index]) {
      this.material = msg.index;
      this.flash(MATERIALS[this.material].name);
    } else if (msg.type === "size" && typeof msg.n === "number") this.setBrush(msg.n);
    else if (
      msg.type === "pointer" &&
      this.pointerSource === "page" &&
      typeof msg.x === "number" &&
      typeof msg.y === "number"
    ) {
      this.pointer.x = Math.max(0, Math.min(1, msg.x));
      this.pointer.y = Math.max(0, Math.min(1, msg.y));
      this.pointer.movedAt = performance.now();
    } else if (msg.type === "click" && this.pointerSource === "page") this.click(String(msg.button ?? "left"));
    else if (msg.type === "wheel") this.setBrush(this.brush + Math.sign(Number(msg.steps) || 0));
    else if (msg.type === "key" && typeof msg.key === "string") this.key(msg.key);
    else if (msg.type === "clear") this.world.cell.fill(M.Empty);
  }

  /** For the dashboard (in /api/status as modeState). */
  state() {
    return {
      material: this.material,
      materials: MATERIALS.map((m) => ({ name: m.name, color: SWATCH[m.id] })),
      size: this.brush,
      pointerSource: this.pointerSource,
    };
  }

  private click(button: string) {
    if (button === "left") {
      this.material = (this.material + 1) % MATERIALS.length;
      this.flash(MATERIALS[this.material].name);
    } else if (button === "right") {
      const [x, y] = this.pointerCell();
      this.world.blast(x, y, 7);
    } else {
      this.world.cell.fill(M.Empty);
      this.flash("Cleared");
    }
  }

  private setBrush(n: number) {
    this.brush = Math.max(1, Math.min(6, n));
    this.flash(`Size ${this.brush}`);
  }

  private key(ch: string) {
    const w = this.world;
    if (ch === " ") {
      // Earthquake: the bottom 4 rows vanish, everything above drops.
      w.cell.copyWithin(4 * w.w, 0, (w.h - 4) * w.w);
      w.extra.copyWithin(4 * w.w, 0, (w.h - 4) * w.w);
      w.cell.fill(M.Empty, 0, 4 * w.w);
      this.flash("Quake!");
      return;
    }
    if (ch === "\n") {
      this.flushUntil = performance.now() + 1500;
      this.flash("Flush!");
      return;
    }
    const k = ch.toUpperCase();
    for (let r = 0; r < ROWS.length; r++) {
      const c = ROWS[r].indexOf(k);
      if (c < 0) continue;
      const x = Math.round((ROW_OFFSET[r] + (c + 0.5) / ROWS[0].length) * w.w);
      const y = Math.min(w.h - 1, w.surface(x) + 3);
      w.blast(x, y, 5);
      return;
    }
    // Any other key: a small crater somewhere.
    const x = Math.floor(Math.random() * w.w);
    w.blast(x, Math.min(w.h - 1, w.surface(x) + 2), 3);
  }

  private flash(text: string) {
    this.hudText = text;
    this.hudUntil = performance.now() + 1500;
  }

  private pointerCell(): [number, number] {
    return [Math.round(this.pointer.x * (this.world.w - 1)), Math.round(this.pointer.y * (this.world.h - 1))];
  }

  private tick(ctx: ModeContext) {
    const w = this.world;
    const now = performance.now();
    this.frame++;
    const since = now - this.pointer.movedAt;
    const mat = MATERIALS[this.material].id;
    const [px, py] = this.pointerCell();
    if (this.pointer.movedAt && since < TRICKLE_MS) {
      // Full stream while moving, thinning out after it stops.
      const density = since < 300 ? 0.6 : 0.6 * (1 - since / TRICKLE_MS);
      if (mat === M.Stone || mat === M.Plant) w.pour(px, py, this.brush, mat, Math.min(1, density + 0.3));
      else w.pour(px, py, this.brush, mat, density * 0.8);
    }
    const leak = now < this.flushUntil || w.count() > w.w * w.h * LEAK_ABOVE;
    for (let s = 0; s < STEPS_PER_FRAME; s++) w.step(leak && (now < this.flushUntil || s === 0));

    const c = new Canvas([6, 6, 10]);
    w.render(c.rgba, W, [6, 6, 10]);
    // Pointer marker (blinks while pouring), and the material/size notice.
    if (since < TRICKLE_MS && this.frame % 4 < 2) c.rect(px * 2 - 1, py * 2 - 1, 4, 4, [255, 255, 255]);
    if (now < this.hudUntil) {
      c.rect(2, 2, 18 + this.hudText.length * 6, 11, [0, 0, 0]);
      c.rect(4, 4, 7, 7, SWATCH[mat]);
      c.text(this.hudText, 15, 4, 1, [255, 255, 255]);
    }
    ctx.show(c.snapshot());
  }
}
