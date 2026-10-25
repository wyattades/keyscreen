// The controls under the mode list, one component per mode that has any.
import { useEffect, useRef, useState } from "react";
import { conn, post, SCREEN_H, SCREEN_W, type Status } from "./connection.ts";
import { DropZone, LiveCanvas } from "./sleep.tsx";

const send = (msg: Record<string, unknown>) => conn.send(msg);

export function ModePanel({ status }: { status: Status }) {
  const m = status.modes.find((x) => x.id === status.mode);
  if (!m) return null;
  const Panel = PANELS[m.id];
  return (
    <section className="card panel">
      <h2>{m.name}</h2>
      <div className="muted">{m.blurb}</div>
      {Panel && <Panel status={status} />}
    </section>
  );
}

const PANELS: Record<string, (p: { status: Status }) => React.ReactNode> = {
  draw: DrawPanel,
  ticker: TickerPanel,
  message: MessagePanel,
  image: ImagePanel,
  life: LifePanel,
  sand: SandPanel,
};

const COLORS: [number, number, number][] = [
  [255, 255, 255],
  [255, 70, 70],
  [255, 160, 40],
  [255, 230, 60],
  [70, 220, 110],
  [60, 220, 230],
  [80, 130, 255],
  [230, 90, 255],
];

/** Draws locally right away, and sends the strokes to the server every 30 ms. */
function DrawPanel() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(2);
  const pending = useRef<number[][]>([]);
  const last = useRef<number[] | null>(null);
  // Latest color/size for the flush timer without restarting it.
  const brush = useRef({ color, size });
  brush.current = { color, size };

  const clearLocal = () => {
    const g = ref.current!.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, SCREEN_W, SCREEN_H);
  };
  useEffect(() => {
    clearLocal();
    const t = setInterval(() => {
      if (!pending.current.length) return;
      send({ type: "draw", segs: pending.current, color: brush.current.color, size: brush.current.size });
      pending.current = [];
    }, 30);
    return () => clearInterval(t);
  }, []);

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * SCREEN_W, ((e.clientY - r.top) / r.height) * SCREEN_H];
  };
  const stroke = (a: number[], b: number[]) => {
    const g = ref.current!.getContext("2d")!;
    g.strokeStyle = `rgb(${color})`;
    g.lineWidth = size * 2 + 1;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
    pending.current.push([...a, ...b].map(Math.round));
  };

  return (
    <>
      <canvas
        id="pad"
        ref={ref}
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
      <div className="row">
        {COLORS.map((c) => (
          <span
            key={c.join()}
            className={`swatch${c === color ? " on" : ""}`}
            style={{ background: `rgb(${c})` }}
            onClick={() => setColor(c)}
          />
        ))}
        <span className="muted">Size</span>
        <input type="range" min={1} max={8} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        <button
          className="act"
          onClick={() => {
            clearLocal();
            send({ type: "clear" });
          }}
        >
          Clear
        </button>
      </div>
    </>
  );
}

function TickerPanel({ status }: { status: Status }) {
  return (
    <div className="row">
      <input
        type="text"
        className="typebox"
        autoFocus
        placeholder="Type here (only needed when the keyboard can't be read directly)"
        onKeyDown={(e) => {
          if (status.keySource !== "page") return; // the server already reads the keyboard; avoid doubles
          if (e.key === "Backspace") send({ type: "key", key: "\b" });
          else if (e.key === "Enter") send({ type: "key", key: "\n" });
          else if (e.key.length === 1) send({ type: "key", key: e.key.toUpperCase() });
        }}
      />
    </div>
  );
}

function MessagePanel() {
  const [text, setText] = useState("");
  const show = () => send({ type: "text", text });
  return (
    <>
      <div className="row">
        <textarea
          autoFocus
          placeholder="Type a message…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              show();
            }
          }}
        />
      </div>
      <div className="row">
        <button className="act primary" onClick={show}>
          Show
        </button>
        <span className="muted">Enter shows it; Shift+Enter for a new line.</span>
      </div>
    </>
  );
}

function ImagePanel() {
  return (
    <div className="row">
      <DropZone
        accept="image/png"
        onFile={async (f) => post("/image", await f.arrayBuffer()).catch((e: Error) => alert(e.message))}
      >
        Drop a PNG here, or click to choose one
      </DropZone>
    </div>
  );
}

function LifePanel() {
  return (
    <div className="row">
      <button className="act" onClick={() => send({ type: "reseed" })}>
        New random start
      </button>
    </div>
  );
}

/** A live pad that stands in for the computer's mouse and keys (useful without the input group). */
function SandPanel() {
  const lastMove = useRef(0);
  return (
    <>
      <div className="muted" style={{ marginTop: 8 }}>
        Move over the pad to pour. Click: next material. Right-click: crater. Wheel: size. Type while it's focused:
        craters (space quakes, enter flushes).
      </div>
      <LiveCanvas
        className="screen sandpad"
        tabIndex={0}
        onPointerMove={(e) => {
          const now = performance.now();
          if (now - lastMove.current < 40) return;
          lastMove.current = now;
          const r = e.currentTarget.getBoundingClientRect();
          send({ type: "pointer", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
        }}
        onClick={(e) => {
          e.currentTarget.focus();
          send({ type: "click", button: "left" });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          send({ type: "click", button: "right" });
        }}
        onWheel={(e) => send({ type: "wheel", steps: Math.sign(-e.deltaY) })}
        onKeyDown={(e) => {
          const key = e.key === "Enter" ? "\n" : e.key;
          if (key.length !== 1) return;
          e.preventDefault();
          send({ type: "key", key });
        }}
      />
      <div className="row">
        <button className="act" onClick={() => send({ type: "clear" })}>
          Clear
        </button>
      </div>
    </>
  );
}
