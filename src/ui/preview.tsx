// "On the keyboard": the live picture (or the sleep animation while asleep). In Draw mode you draw
// right on it; in Sand mode it stands in for the mouse only when the computer's mouse can't be read.
import { useRef } from "react";
import { conn, SCREEN_H, SCREEN_W, type Status } from "./connection.ts";
import { LiveCanvas, StripCanvas, type Strip } from "./sleep.tsx";

export interface Brush {
  color: [number, number, number];
  size: number;
}

export function Preview({ status, sleepStrip, brush }: { status: Status; sleepStrip?: Strip; brush: Brush }) {
  const sandPad = status.mode === "sand" && status.modeState?.pointerSource === "page";
  return (
    <div className="bezel">
      <div className="screenbox">
        {sleepStrip ? (
          <StripCanvas className="screen" strip={sleepStrip} />
        ) : sandPad ? (
          <SandPad />
        ) : (
          <LiveCanvas className="screen" />
        )}
        {status.mode === "draw" && !sleepStrip && <Ink brush={brush} />}
      </div>
    </div>
  );
}

/**
 * A transparent layer over the preview for drawing. Strokes show here instantly and are sent to
 * the server every 30 ms; each one fades once the live picture (which now includes it) catches up.
 */
function Ink({ brush }: { brush: Brush }) {
  const ref = useRef<HTMLCanvasElement>(null);
  /** Strokes on the layer (until it fades), each drawn as one path so its soft edges blend once. */
  const strokes = useRef<{ id: number; points: number[][]; color: Brush["color"]; size: number }[]>([]);
  const drawing = useRef(false);
  const nextId = useRef(Date.now());
  const pending = useRef<number[][]>([]);
  const flush = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fade = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Quarter pixels: what the server gets, so both draw exactly the same line.
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * SCREEN_W, ((e.clientY - r.top) / r.height) * SCREEN_H].map(
      (v) => Math.round(v * 4) / 4,
    );
  };
  const current = () => strokes.current[strokes.current.length - 1];
  const send = () => {
    flush.current = undefined;
    const s = current();
    if (!pending.current.length || !s) return;
    conn.send({ type: "draw", stroke: s.id, segs: pending.current, color: s.color, size: s.size });
    pending.current = [];
  };
  // Width 2 * size + 1 with round ends, like the server (src/modes.ts DrawMode).
  const redraw = () => {
    const g = ref.current!.getContext("2d")!;
    g.clearRect(0, 0, SCREEN_W, SCREEN_H);
    g.lineCap = g.lineJoin = "round";
    for (const s of strokes.current) {
      g.strokeStyle = `rgb(${s.color})`;
      g.lineWidth = s.size * 2 + 1;
      g.beginPath();
      g.moveTo(s.points[0][0], s.points[0][1]);
      for (const [x, y] of s.points) g.lineTo(x, y);
      g.stroke();
    }
  };
  const add = (p: number[]) => {
    const s = current();
    const prev = s.points[s.points.length - 1] ?? p;
    s.points.push(p);
    pending.current.push([...prev, ...p]);
    flush.current ??= setTimeout(send, 30);
    redraw();
    fadeSoon();
  };
  // Clear the ink once the server's frames have caught up with the last stroke.
  const fadeSoon = () => {
    clearTimeout(fade.current);
    fade.current = setTimeout(() => {
      if (drawing.current) return;
      strokes.current = [];
      redraw();
    }, 600);
  };
  const end = () => {
    drawing.current = false;
    fadeSoon();
  };

  return (
    <canvas
      ref={ref}
      className="ink"
      width={SCREEN_W}
      height={SCREEN_H}
      onPointerDown={(e) => {
        ref.current!.setPointerCapture(e.pointerId);
        send();
        drawing.current = true;
        strokes.current.push({ id: nextId.current++, points: [], color: brush.color, size: brush.size });
        add(at(e));
      }}
      onPointerMove={(e) => drawing.current && add(at(e))}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}

/** Only when the server can't read the computer's mouse: pour by moving over the preview. */
function SandPad() {
  const lastMove = useRef(0);
  return (
    <LiveCanvas
      className="screen sandpad"
      onPointerMove={(e) => {
        const now = performance.now();
        if (now - lastMove.current < 40) return;
        lastMove.current = now;
        const r = e.currentTarget.getBoundingClientRect();
        conn.send({ type: "pointer", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
      }}
      onClick={() => conn.send({ type: "click", button: "left" })}
      onContextMenu={(e) => {
        e.preventDefault();
        conn.send({ type: "click", button: "right" });
      }}
    />
  );
}
