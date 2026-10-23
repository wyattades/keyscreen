// Keyboard test lab: on-device experiments with a dashboard for running them and recording results.
//
//   bun lab/lab.ts              start the dashboard on http://localhost:4108   (same as: pnpm lab)
//   bun lab/lab.ts run <id>     run one test case in this terminal
//   bun lab/lab.ts list         list test cases (and render their expected-screens pictures)
//   bun lab/lab.ts watch        print a line for each new result reported on the dashboard
//
// Test cases live in lab/cases.ts. Results go to lab/results.jsonl, run logs to lab/runs/.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const LAB = import.meta.dir;
const ROOT = join(LAB, "..");
const RESULTS = join(LAB, "results.jsonl");
const RUNS = join(LAB, "runs");
const STATUS = join(LAB, "status.json");
const PICTURES = join(LAB, "pictures");

const [cmd = "serve", ...args] = process.argv.slice(2);
switch (cmd) {
  case "serve":
    serve(Number(process.env.PORT ?? 4108));
    break;
  case "run":
    await runCase(args[0]);
    break;
  case "list":
    await listCases(args.includes("--json"));
    break;
  case "watch":
    watchResults();
    break;
  default:
    console.error("usage: bun lab/lab.ts [serve | run <id> | list | watch]");
    process.exit(1);
}

// ---------------------------------------------------------------------------------------------
// run / list (load the cases only here, so the dashboard picks up edits without restarting)

async function runCase(id: string | undefined) {
  const { cases } = await import("./cases.ts");
  const { withContext } = await import("./harness.ts");
  const tc = cases.find((c) => c.id === id);
  if (!tc) {
    console.error(`unknown test "${id}". Known: ${cases.filter((c) => !c.archived).map((c) => c.id).join(", ")}`);
    process.exit(1);
  }
  if (tc.archived) {
    console.error(`"${id}" is archived: ${tc.archived}`);
    process.exit(1);
  }
  const t0 = Date.now();
  const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  try {
    await withContext(log, !tc.noLayout, (t) => tc.run(t));
    log("FINISHED");
    process.exit(0);
  } catch (e) {
    log(`ERROR: ${(e as Error).message}`);
    process.exit(2);
  }
}

async function listCases(json: boolean) {
  const { cases } = await import("./cases.ts");
  const { renderSheet } = await import("./sheet.ts");
  mkdirSync(PICTURES, { recursive: true });
  const out = cases.map((c) => {
    writeFileSync(join(PICTURES, `${c.id}.png`), renderSheet(c.expect()));
    return { id: c.id, title: c.title, description: c.description, success: c.success, archived: c.archived ?? null, readOnly: !!c.readOnly, interactive: c.interactive ?? null, react: c.react ?? null };
  });
  if (json) console.log(JSON.stringify(out));
  else for (const c of out) console.log(`${c.archived ? "  (archived) " : ""}${c.id.padEnd(22)} ${c.title}`);
}

// ---------------------------------------------------------------------------------------------
// watch: one line per new report (used by Claude to follow results)

function watchResults() {
  if (!existsSync(RESULTS)) writeFileSync(RESULTS, "");
  let offset = statSync(RESULTS).size;
  const check = () => {
    const size = statSync(RESULTS).size;
    if (size < offset) offset = 0;
    if (size === offset) return;
    const chunk = readFileSync(RESULTS).subarray(offset, size).toString("utf8");
    const end = chunk.lastIndexOf("\n");
    if (end < 0) return;
    offset += Buffer.byteLength(chunk.slice(0, end + 1));
    for (const line of chunk.slice(0, end).split("\n").filter((l) => l.trim())) {
      try {
        const r = JSON.parse(line);
        const note = String(r.note ?? "").replace(/\s+/g, " ").trim();
        console.log(`REPORT ${r.id}: ${r.outcome}${note ? ` — "${note}"` : ""} (exit ${r.run?.exitCode ?? "n/a"}, log ${r.run?.logPath ?? "none"})`);
      } catch {
        console.log(`REPORT (unparseable): ${line.slice(0, 200)}`);
      }
    }
  };
  watch(RESULTS, check);
  setInterval(check, 2000);
}

// ---------------------------------------------------------------------------------------------
// serve: the dashboard

interface CaseInfo {
  id: string;
  title: string;
  description: string;
  success: string;
  archived: string | null;
  readOnly: boolean;
  interactive: string | null;
  react: string | null;
}
interface Run {
  id: string;
  startedAt: string;
  lines: string[];
  exitCode: number | null;
  logPath: string;
}

function serve(port: number) {
  mkdirSync(RUNS, { recursive: true });
  let cases: CaseInfo[] = [];
  let casesMtime = 0;
  let casesError = "";
  let current: Run | null = null;
  let runPid = 0;
  let runStdin: import("bun").FileSink | undefined;
  const lastRun = new Map<string, Run>();

  async function refreshCases() {
    const mtime = statSync(join(LAB, "cases.ts")).mtimeMs;
    if (mtime === casesMtime && cases.length) return;
    const p = Bun.spawn(["bun", join(LAB, "lab.ts"), "list", "--json"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    if ((await p.exited) === 0) {
      cases = JSON.parse(out);
      casesError = "";
      casesMtime = mtime;
    } else {
      casesError = err.trim().split("\n").slice(-6).join("\n");
    }
  }

  /** Other processes holding the keyboard's or screen's HID nodes (Chrome with Hub, the screen server…). */
  function holders(): string[] {
    const nodes = new Set<string>();
    for (const name of readdirSync("/sys/class/hidraw")) {
      try {
        const ue = readFileSync(`/sys/class/hidraw/${name}/device/uevent`, "utf8");
        if (/HID_ID=0003:0000(36B0:000030AF|1919:00001919)/.test(ue)) nodes.add(`/dev/${name}`);
      } catch {}
    }
    const found = new Set<string>();
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      if (Number(pid) === process.pid || (current && pid === String(runPid))) continue;
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          if (nodes.has(readlinkSync(`/proc/${pid}/fd/${fd}`))) {
            const c = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
            found.add(`${c.slice(0, 3).join(" ").split("/").pop()} (pid ${pid})`);
          }
        } catch {}
      }
    }
    return [...found];
  }

  function results(): any[] {
    if (!existsSync(RESULTS)) return [];
    return readFileSync(RESULTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  async function startRun(id: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const run: Run = { id, startedAt: new Date().toISOString(), lines: [], exitCode: null, logPath: `lab/runs/${ts}-${id}.log` };
    current = run;
    lastRun.set(id, run);
    const p = Bun.spawn(["bun", join(LAB, "lab.ts"), "run", id], { cwd: ROOT, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    runPid = p.pid;
    runStdin = p.stdin;
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream) {
        buf += dec.decode(chunk, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        run.lines.push(...parts);
      }
      if (buf) run.lines.push(buf);
    };
    await Promise.all([pump(p.stdout), pump(p.stderr), p.exited]);
    run.exitCode = p.exitCode;
    runStdin = undefined;
    writeFileSync(join(ROOT, run.logPath), run.lines.join("\n") + "\n");
    current = null;
  }

  Bun.serve({
    port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response(Bun.file(join(LAB, "page.html")));
      if (url.pathname.startsWith("/pictures/")) {
        const f = Bun.file(join(PICTURES, url.pathname.slice("/pictures/".length).replace(/\.\./g, "")));
        return (await f.exists()) ? new Response(f, { headers: { "cache-control": "no-store" } }) : new Response("not found", { status: 404 });
      }
      if (url.pathname === "/api/state") {
        await refreshCases();
        const status = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, "utf8")) : {};
        const byCase: Record<string, any[]> = {};
        for (const r of results()) (byCase[r.id] ??= []).push({ ts: r.ts, outcome: r.outcome, note: r.note });
        const runs: Record<string, any> = {};
        for (const [id, r] of lastRun) runs[id] = { startedAt: r.startedAt, exitCode: r.exitCode, lines: r.lines.slice(-200), running: current === r };
        return Response.json({ status, cases, casesError, running: current?.id ?? null, holders: holders(), runs, results: byCase, casesVersion: casesMtime });
      }
      if (url.pathname === "/api/run" && req.method === "POST") {
        const { id } = await req.json();
        if (current) return Response.json({ error: `"${current.id}" is still running` }, { status: 409 });
        const c = cases.find((x) => x.id === id);
        if (!c || c.archived) return Response.json({ error: "unknown or archived test" }, { status: 400 });
        const h = holders();
        if (h.length) return Response.json({ error: `Something else is using the keyboard: ${h.join(", ")}. Stop it (the screen server, or Hub / web tool tabs) first.` }, { status: 409 });
        void startRun(id);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/input" && req.method === "POST") {
        if (!current || !runStdin) return Response.json({ error: "nothing running" }, { status: 409 });
        const { lines } = (await req.json()) as { lines: string[] };
        const safe = lines.filter((l) => /^(dot -?\d+ -?\d+|clear|lead \d+|seen \d+)$/.test(l));
        if (safe.length) {
          runStdin.write(safe.join("\n") + "\n");
          runStdin.flush();
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/report" && req.method === "POST") {
        const { id, outcome, note } = await req.json();
        const c = cases.find((x) => x.id === id);
        const r = lastRun.get(id);
        appendFileSync(RESULTS, JSON.stringify({
          ts: new Date().toISOString(),
          id,
          title: c?.title,
          outcome,
          note: String(note ?? "").trim(),
          run: r ? { startedAt: r.startedAt, exitCode: r.exitCode, logPath: r.logPath, tail: r.lines.slice(-12) } : null,
        }) + "\n");
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`test lab on http://localhost:${port}`);
}
