// Shared canvases (live frames, animated frame strips), the file drop zone, and the
// "While the computer is locked" section.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { conn, post, SCREEN_H, SCREEN_W, type Status } from "./connection.ts";

/** A canvas showing the live frames as they go to the keyboard. Extra props go to the canvas. */
export function LiveCanvas(props: React.CanvasHTMLAttributes<HTMLCanvasElement>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current!.getContext("2d")!;
    return conn.onFrame((rgba) => g.putImageData(new ImageData(rgba, SCREEN_W, SCREEN_H), 0, 0));
  }, []);
  return <canvas ref={ref} width={SCREEN_W} height={SCREEN_H} {...props} />;
}

/** A sleep animation's frames in a grid image (from /api/sleep/preview.png). */
export interface Strip {
  img: HTMLImageElement;
  frames: number;
  cols: number;
  fps: number;
}

/** Loads the preview strip for each sleep animation; reloads when `version` changes. */
export function useStrips(ids: string[], version: unknown): Record<string, Strip> {
  const [strips, setStrips] = useState<Record<string, Strip>>({});
  const key = ids.join(",");
  useEffect(() => {
    let live = true;
    for (const id of ids) {
      if (id === "off") continue;
      void fetch(`/api/sleep/preview.png?mode=${id}&t=${Date.now()}`).then(async (r) => {
        if (!r.ok || !live) return;
        const img = new Image();
        img.src = URL.createObjectURL(await r.blob());
        await img.decode();
        const strip = {
          img,
          frames: Number(r.headers.get("x-frames")),
          cols: Number(r.headers.get("x-cols")) || Number(r.headers.get("x-frames")),
          fps: Number(r.headers.get("x-fps")),
        };
        if (live) setStrips((s) => ({ ...s, [id]: strip }));
      });
    }
    return () => {
      live = false;
    };
  }, [key, version]);
  return strips;
}

/** Plays a frame strip on a canvas. */
export function StripCanvas({ strip, className }: { strip: Strip | undefined; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!strip) return;
    const g = ref.current!.getContext("2d")!;
    let raf = 0;
    const draw = (t: number) => {
      const f = Math.floor((t / 1000) * strip.fps) % strip.frames;
      const sx = (f % strip.cols) * SCREEN_W,
        sy = Math.floor(f / strip.cols) * SCREEN_H;
      g.drawImage(strip.img, sx, sy, SCREEN_W, SCREEN_H, 0, 0, SCREEN_W, SCREEN_H);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [strip]);
  return <canvas ref={ref} className={className} width={SCREEN_W} height={SCREEN_H} />;
}

/** A click-or-drop file picker. */
export function DropZone({
  accept,
  onFile,
  children,
}: {
  accept: string;
  onFile: (f: File) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <label
      className={`drop${over ? " over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      {children}
      <input type="file" accept={accept} hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </label>
  );
}

export function SleepSection({
  status,
  strips,
  refresh,
  onUploaded,
}: {
  status: Status;
  strips: Record<string, Strip>;
  refresh: () => void;
  onUploaded: () => void;
}) {
  const sl = status.sleep;
  const act = (body: unknown) =>
    post("/api/sleep", body)
      .catch((e: Error) => alert(e.message))
      .then(refresh);
  const upload = async (file: File) => {
    try {
      await post("/api/sleep/upload", await file.arrayBuffer());
      onUploaded();
    } catch (e) {
      alert((e as Error).message);
    }
    refresh();
  };
  return (
    <section className="card panel">
      <h2>While the computer is locked</h2>
      <p className="muted" style={{ margin: "0 0 10px" }}>
        The keyboard plays this animation on its own and the computer stops sending anything, until you unlock.
      </p>
      <div className="modes">
        {sl.modes
          .filter((m) => m.id !== "custom" || sl.hasUpload)
          .map((m) => (
            <button key={m.id} className={`mode${m.id === sl.mode ? " on" : ""}`} onClick={() => act({ mode: m.id })}>
              {m.id !== "off" && <StripCanvas strip={strips[m.id]} />}
              <b>{m.name}</b>
              <span>{m.blurb}</span>
            </button>
          ))}
      </div>
      <div className="row">
        <DropZone accept="image/png,image/gif" onFile={upload}>
          Use your own: drop a PNG or animated GIF here, or click to choose one
        </DropZone>
      </div>
      <div className="row">
        <button
          className="act"
          disabled={sl.mode === "off" || (sl.asleep && !sl.trying)}
          onClick={() => act({ action: sl.asleep ? "wake" : "try" })}
        >
          {sl.asleep ? "Wake up" : "Try it on the keyboard"}
        </button>
        <span className="muted">
          {sl.asleep
            ? sl.locked
              ? "Asleep: the computer is locked."
              : "Asleep (trying it). The live mode comes back when you wake it."
            : ""}
        </span>
      </div>
    </section>
  );
}
