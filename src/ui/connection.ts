// The page's link to the screen server: one WebSocket (reconnecting) for mode messages out and
// live frames in, plus the status shape from GET /api/status.
//
// Frames arrive as raw RGBA (240x136) as they go to the keyboard. They're handed straight to
// subscribers (canvases) rather than through React state, so 10+ frames a second never re-render
// the page.

export const SCREEN_W = 240,
  SCREEN_H = 136;

export interface ModeInfo {
  id: string;
  name: string;
  blurb: string;
}

export interface Status {
  state: string;
  fake: boolean;
  lastError: string;
  mode?: string;
  note: string;
  keySource: "keyboard" | "page" | null;
  modes: ModeInfo[];
  stats: { contentFrames: number; rotations: number } | null;
  sleep: {
    mode: string;
    modes: ModeInfo[];
    asleep: boolean;
    locked: boolean;
    trying: boolean;
    hasUpload: boolean;
  };
  log: string[];
}

type FrameListener = (rgba: Uint8ClampedArray<ArrayBuffer>) => void;

class Connection {
  private ws: WebSocket | undefined;
  private listeners = new Set<FrameListener>();
  /** The latest frame, so a canvas that mounts later can draw straight away. */
  last: Uint8ClampedArray<ArrayBuffer> | undefined;

  constructor() {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.last = new Uint8ClampedArray(e.data);
        for (const f of this.listeners) f(this.last);
      } else {
        try {
          const m = JSON.parse(e.data);
          if (m.error) console.warn(m.error);
        } catch {}
      }
    };
    ws.onclose = () => setTimeout(() => this.connect(), 1000);
    this.ws = ws;
  }

  /** Sends a mode message (dropped if not connected; they're all live input). */
  send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onFrame(f: FrameListener): () => void {
    this.listeners.add(f);
    if (this.last) f(this.last);
    return () => this.listeners.delete(f);
  }
}

export const conn = new Connection();

/** POST helper for the JSON API; throws the server's error message. */
export async function post(path: string, body: unknown): Promise<void> {
  const r = await fetch(path, {
    method: "POST",
    body: body instanceof ArrayBuffer || typeof body === "string" ? body : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
}
