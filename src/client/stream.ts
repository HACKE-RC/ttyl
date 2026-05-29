// `ttyl stream` wraps a shell in a local PTY, mirrors it to your terminal, and
// broadcasts it to a relay so viewers can watch (and, with the read-write link,
// type) over the web. It is the broadcaster side of the protocol.
import { createRequire } from "node:module";
import { decode, encode, Kind } from "../core/wire";
import { parseLifetime, printLinks, resolveServer } from "./util";

// node-pty is a native CommonJS module; require it to avoid ESM/CJS interop.
const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

export interface StreamArgs {
  server: string;
  viewOnly: boolean;
  lifetime: string;
  command: string[];
}

export async function runStream(args: StreamArgs): Promise<void> {
  const ttl = parseLifetime(args.lifetime); // throws on bad input
  const server = await resolveServer(args.server);

  const { id, key } = await createSession(server, ttl);

  const ws = new WebSocket(broadcastURL(server, id));
  ws.binaryType = "arraybuffer";
  await waitOpen(ws);

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Prove read-write capability with an Auth frame as the very first message.
  if (key) {
    ws.send(encode({ kind: Kind.Auth, data: enc.encode(key) }));
  }

  printLinks(server, id, key, args.viewOnly);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const command = args.command.length > 0 ? args.command : [process.env.SHELL || "/bin/sh"];
  const term = pty.spawn(command[0], command.slice(1), {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
  });

  // Broadcast the initial size before any output so late math lines up.
  ws.send(encode({ kind: Kind.Resize, cols, rows }));

  let closed = false;
  const cleanup = (code: number): void => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
    } catch {
      // ignore
    }
    process.stdin.pause();
    try {
      term.kill();
    } catch {
      // ignore
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };

  // PTY output: mirror locally and broadcast.
  term.onData((chunk) => {
    process.stdout.write(chunk);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encode({ kind: Kind.Output, data: enc.encode(chunk) }));
    }
  });
  term.onExit(() => cleanup(0));

  // Viewer keystrokes (read-write viewers) flow back into the PTY.
  ws.addEventListener("message", (ev) => {
    if (!(ev.data instanceof ArrayBuffer)) {
      return;
    }
    let frame;
    try {
      frame = decode(new Uint8Array(ev.data));
    } catch {
      return;
    }
    if (frame.kind === Kind.Input && frame.data) {
      term.write(dec.decode(frame.data));
    }
  });
  ws.addEventListener("close", () => cleanup(0));
  ws.addEventListener("error", () => cleanup(1));

  // Local keystrokes flow into the PTY (raw mode; the shell echoes them back
  // through onData, so we do not echo locally).
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (buf: Buffer) => term.write(buf.toString("utf8")));

  // Local resize: match the PTY and tell viewers.
  process.stdout.on("resize", () => {
    const c = process.stdout.columns || cols;
    const r = process.stdout.rows || rows;
    try {
      term.resize(c, r);
    } catch {
      // ignore transient resize errors
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encode({ kind: Kind.Resize, cols: c, rows: r }));
    }
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("connect to server failed")), { once: true });
  });
}

async function createSession(
  server: string,
  ttl: number | undefined,
): Promise<{ id: string; key: string }> {
  const url = new URL(`${server.replace(/\/+$/, "")}/api/sessions`);
  if (ttl !== undefined) {
    url.searchParams.set("ttl", String(ttl));
  }
  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`create session: server returned ${res.status}`);
  }
  const body = (await res.json()) as { id?: string; key?: string };
  if (!body.id) {
    throw new Error("create session: server returned empty session id");
  }
  return { id: body.id, key: body.key ?? "" };
}

function broadcastURL(server: string, id: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `/ws/${id}/broadcast`;
  u.search = "";
  u.hash = "";
  return u.toString();
}
