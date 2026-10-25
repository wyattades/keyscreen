// The controls under the mode list, one component per mode that has any.
import { useState } from "react";
import { conn, post, type Status } from "./connection.ts";
import type { Brush } from "./preview.tsx";
import { DropZone } from "./sleep.tsx";

const send = (msg: Record<string, unknown>) => conn.send(msg);

interface PanelProps {
  status: Status;
  brush: Brush;
  setBrush: (b: Brush) => void;
}

export const defaultBrush = (): Brush => ({ color: COLORS[0], size: 2 });

export function ModePanel(props: PanelProps) {
  const { status } = props;
  const m = status.modes.find((x) => x.id === status.mode);
  if (!m) return null;
  const Panel = PANELS[m.id];
  return (
    <section className="card panel">
      <h2>{m.name}</h2>
      <div className="muted">{m.blurb}</div>
      {Panel && <Panel {...props} />}
    </section>
  );
}

const PANELS: Record<string, (p: PanelProps) => React.ReactNode> = {
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
  [0, 0, 0], // the background: an eraser
];

/** Brush controls; you draw right on the "On the keyboard" preview. */
function DrawPanel({ brush, setBrush }: PanelProps) {
  return (
    <>
      <p className="muted">Draw right on the picture above.</p>
      <div className="row">
        {COLORS.map((c) => (
          <span
            key={c.join()}
            className={`swatch${c === brush.color ? " on" : ""}${c.every((v) => v === 0) ? " eraser" : ""}`}
            title={c.every((v) => v === 0) ? "Eraser (black)" : undefined}
            style={{ background: `rgb(${c})` }}
            onClick={() => setBrush({ ...brush, color: c })}
          />
        ))}
        <span className="muted">Size</span>
        <input
          type="range"
          min={1}
          max={8}
          value={brush.size}
          onChange={(e) => setBrush({ ...brush, size: Number(e.target.value) })}
        />
        <button className="act" onClick={() => send({ type: "clear" })}>
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

/** Material, size and clear. The pointer itself comes from the computer's mouse. */
function SandPanel({ status }: PanelProps) {
  const st = status.modeState as {
    material: number;
    materials: { name: string; color: [number, number, number] }[];
    size: number;
    pointerSource: "gnome" | "estimate" | "page";
  } | null;
  if (!st) return null;
  return (
    <>
      <p className="muted">
        {st.pointerSource === "page"
          ? "Move over the picture above to pour; click it for the next material, right-click for a crater."
          : "Move your mouse anywhere on your monitor to pour. Left click: next material. Right click: crater. Wheel: size. Typing blasts craters (space quakes, enter flushes)."}
      </p>
      <div className="row">
        {st.materials.map((m, i) => (
          <button
            key={m.name}
            className={`act material${i === st.material ? " on" : ""}`}
            onClick={() => send({ type: "material", index: i })}
          >
            <span className="dot" style={{ background: `rgb(${m.color})` }} />
            {m.name}
          </button>
        ))}
      </div>
      <div className="row">
        <span className="muted">Size</span>
        <input
          type="range"
          min={1}
          max={6}
          value={st.size}
          onChange={(e) => send({ type: "size", n: Number(e.target.value) })}
        />
        <button className="act" onClick={() => send({ type: "clear" })}>
          Clear
        </button>
      </div>
    </>
  );
}
