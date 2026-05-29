// `ttyl stream` wraps a shell in a local PTY, mirrors it to your terminal, and
// broadcasts it to a relay so viewers can watch (and, with the read-write link,
// type) over the web. It is the broadcaster side of the protocol.
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { decode, encode, Kind } from "../core/wire";
import { encodeAuthPayload } from "../core/auth";
import { parseLifetime, printLinks, promptHidden, resolveServer } from "./util";
import { startControlServer } from "./control";

export interface StreamArgs {
  server: string;
  viewOnly: boolean;
  lifetime: string;
  // password true means "prompt for a session password and protect viewers".
  password: boolean;
  command: string[];
}

// If the broadcaster's link to the relay stalls, skip output past this many
// buffered bytes rather than growing memory without bound (viewers see a gap;
// the live mirror is unaffected).
const SEND_BUFFER_CAP = 16 * 1024 * 1024;

export async function runStream(args: StreamArgs): Promise<void> {
  const ttl = parseLifetime(args.lifetime); // throws on bad input
  const server = await resolveServer(args.server);

  // Prompt for the session password before anything else so it never lands in
  // shell history; it gates every viewer that joins.
  const password = args.password ? await promptHidden("Set a session password: ") : undefined;

  // node-pty is a native module; require it only here so `serve`/`init` work
  // even if its build is unavailable.
  const require = createRequire(import.meta.url);
  const pty = require("node-pty") as typeof import("node-pty");

  const { id, key, admin } = await createSession(server, ttl, password);

  const ws = new WebSocket(broadcastURL(server, id));
  ws.binaryType = "arraybuffer";
  await waitOpen(ws);

  // Prove read-write capability with an Auth frame as the very first message.
  // The broadcaster authenticates with the control key only (the session
  // password never applies to it).
  if (key) {
    ws.send(encode({ kind: Kind.Auth, data: encodeAuthPayload({ k: key }) }));
  }

  printLinks(server, id, key, admin, args.viewOnly);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const command = args.command.length > 0 ? args.command : [process.env.SHELL || "/bin/sh"];

  // Publish the links on a local control socket so `ttyl links` can reprint them
  // later. Best-effort: if it fails, the stream still runs (just no recovery).
  const stopControl = await startControlServer(
    {
      id,
      key,
      admin,
      server,
      viewOnly: args.viewOnly,
      cwd: process.cwd(),
      command: command.join(" "),
      startedAt: Date.now(),
    },
    // `ttyl stop` (from another terminal) tears the session down via the same
    // path as a normal exit.
    () => cleanup(0),
  );
  // encoding: null makes the PTY emit raw Buffers, so binary / non-UTF-8 output
  // is forwarded byte-for-byte instead of being mangled by string decoding.
  const term = pty.spawn(command[0], command.slice(1), {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
    encoding: null,
  });

  // Broadcast the initial size before any output.
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
    void stopControl(); // remove the local control socket (best effort)
    // Give the final output a moment to flush to stdout and over the socket.
    setTimeout(() => process.exit(code), 50);
  };

  // PTY output: mirror locally and broadcast (raw bytes).
  term.onData((chunk: string | Buffer) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    process.stdout.write(buf);
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < SEND_BUFFER_CAP) {
      ws.send(encode({ kind: Kind.Output, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) }));
    }
  });
  term.onExit(() => cleanup(0));

  // Viewer keystrokes (read-write viewers) flow back into the PTY as raw bytes.
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
      term.write(Buffer.from(frame.data));
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
  process.stdin.on("data", (buf: Buffer) => term.write(buf));

  // Restore the terminal if we are signalled to quit, so it is not left in raw
  // mode. (In raw mode Ctrl-C reaches the PTY child, not us.)
  process.on("SIGTERM", () => cleanup(0));
  process.on("SIGHUP", () => cleanup(0));

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
  password: string | undefined,
): Promise<{ id: string; key: string; admin: string }> {
  const url = new URL(`${server.replace(/\/+$/, "")}/api/sessions`);
  if (ttl !== undefined) {
    url.searchParams.set("ttl", String(ttl));
  }
  const init: RequestInit = { method: "POST" };
  if (password) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({ password });
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`create session: server returned ${res.status}`);
  }
  const body = (await res.json()) as { id?: string; key?: string; admin?: string };
  if (!body.id) {
    throw new Error("create session: server returned empty session id");
  }
  return { id: body.id, key: body.key ?? "", admin: body.admin ?? "" };
}

function broadcastURL(server: string, id: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `/ws/${id}/broadcast`;
  u.search = "";
  u.hash = "";
  return u.toString();
}
