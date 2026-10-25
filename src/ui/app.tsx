// The keyscreen dashboard. Served by the screen server through Bun's HTML import, which bundles
// this file (and style.css) from index.html. `keyscreen serve --dev` re-bundles on each load.
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { conn, post, type Status } from "./connection.ts";
import { ModePanel } from "./panels.tsx";
import { LiveCanvas, SleepSection, StripCanvas, useStrips } from "./sleep.tsx";

type Down = "stopped" | "unreachable" | null;

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [down, setDown] = useState<Down>(null);
  const [stopping, setStopping] = useState(false);
  const [uploads, setUploads] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setStatus(await fetch("/api/status").then((r) => r.json()));
      setDown(null);
      setStopping(false);
    } catch {
      setDown((d) => (d === "stopped" ? d : stopping ? "stopped" : "unreachable"));
    }
  }, [stopping]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, [refresh]);

  const sleepIds =
    status?.sleep.modes.filter((m) => m.id !== "custom" || status.sleep.hasUpload).map((m) => m.id) ?? [];
  const strips = useStrips(sleepIds, uploads);

  if (!status)
    return (
      <main>
        <Header status={null} down={down} onStop={() => {}} />
      </main>
    );

  const setMode = (id: string) => {
    conn.send({ type: "mode", id });
    setStatus({ ...status, mode: id });
  };
  const stop = async () => {
    if (!confirm("Stop the screen server? The keyboard screen stops updating until it's started again.")) return;
    setStopping(true);
    await post("/api/shutdown", {}).catch(() => {});
    setDown("stopped");
  };

  const s = status.state;
  const alert = s === "frozen" || s === "no keyboard";
  const sleepStrip = status.sleep.asleep ? strips[status.sleep.mode] : undefined;

  return (
    <main>
      <Header status={status} down={down} onStop={stop} />
      {alert && !down && <div className="banner alert">{status.lastError}</div>}
      <div className="grid">
        <section className="card">
          <h2>On the keyboard</h2>
          {sleepStrip ? <StripCanvas className="screen" strip={sleepStrip} /> : <LiveCanvas className="screen" />}
          <div className="stats">
            {status.stats &&
              `${status.stats.contentFrames} frames sent · ${status.stats.rotations} flash recycles · the keyboard shows each frame ~0.4 s after it appears here`}
          </div>
        </section>
        <section className="card">
          <h2>Mode</h2>
          <div className="modes">
            {status.modes.map((m) => (
              <button key={m.id} className={`mode${m.id === status.mode ? " on" : ""}`} onClick={() => setMode(m.id)}>
                <b>{m.name}</b>
                <span>{m.blurb}</span>
              </button>
            ))}
          </div>
          {status.note && <div className="banner">{status.note}</div>}
        </section>
      </div>
      <ModePanel key={status.mode} status={status} />
      <SleepSection status={status} strips={strips} refresh={refresh} onUploaded={() => setUploads((n) => n + 1)} />
      <div className="log">{status.log.join("\n")}</div>
    </main>
  );
}

function Header({ status, down, onStop }: { status: Status | null; down: Down; onStop: () => void }) {
  let text = "connecting…",
    cls = "";
  if (down) {
    text = down === "stopped" ? "server stopped" : "server not reachable";
    cls = "bad";
  } else if (status) {
    const s = status.state;
    const alert = s === "frozen" || s === "no keyboard";
    text =
      s === "running"
        ? "live"
        : s === "frozen"
          ? "screen frozen"
          : alert
            ? s
            : s + (status.lastError ? ` — ${status.lastError}` : "");
    cls = s === "running" ? "ok" : s === "reconnecting" || alert ? "bad" : "";
  }
  return (
    <header>
      <h1>Keyboard screen</h1>
      <span className={`chip ${cls}`}>{text}</span>
      {status && !down && (
        <button className="act" style={{ marginLeft: "auto" }} onClick={onStop}>
          Stop server
        </button>
      )}
    </header>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
