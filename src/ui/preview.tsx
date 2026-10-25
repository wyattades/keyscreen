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
  const last = useRef<number[] | null>(null);
  const pending = useRef<number[][]>([]);
  const flush = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fade = useRef<ReturnType<typeof setTimeout>>(undefined);

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * SCREEN_W, ((e.clientY - r.top) / r.height) * SCREEN_H];
  };
  const send = () => {
    flush.current = undefined;
    if (!pending.current.length) return;
    conn.send({ type: "draw", segs: pending.current, color: brush.color, size: brush.size });
    pending.current = [];
  };
  const stroke = (a: number[], b: number[]) => {
    // Smooth like the server's lines (src/modes.ts DrawMode): width 2 * size + 1, round ends.
    const g = ref.current!.getContext("2d")!;
    g.strokeStyle = `rgb(${brush.color})`;
    g.lineWidth = brush.size * 2 + 1;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
    pending.current.push([...a, ...b].map((v) => Math.round(v * 4) / 4));
    flush.current ??= setTimeout(send, 30);
    // Clear the ink once the server's frames have caught up with the last stroke.
    clearTimeout(fade.current);
    fade.current = setTimeout(() => g.clearRect(0, 0, SCREEN_W, SCREEN_H), 600);
  };

  return (
    <canvas
      ref={ref}
      className="ink"
      width={SCREEN_W}
      height={SCREEN_H}
      onPointerDown={(e) => {
        ref.current!.setPointerCapture(e.pointerId);
        last.current = at(e);
        stroke(last.current, last.current);
      }}
      onPointerMove={(e) => {
        if (!last.current) return;
        const p = at(e);
        stroke(last.current, p);
        last.current = p;
      }}
      onPointerUp={() => (last.current = null)}
      onPointerCancel={() => (last.current = null)}
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
