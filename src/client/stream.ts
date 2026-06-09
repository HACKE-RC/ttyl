// `ttyl stream` wraps a shell in a local PTY, mirrors it to your terminal, and
// broadcasts it to a relay so viewers can watch (and, with the read-write link,
// type) over the web. It is the broadcaster side of the protocol.
import { createRequire } from "node:module";
import { WebSocket } from "ws";
import { decode, encode, Kind } from "../core/wire";
import { encodeAuthPayload } from "../core/auth";
import { createTtylVaultWriter, resolveTtylVaultSettings, type TtylVaultCliArgs } from "./ttylvault";
import { DEFAULT_RECORD_FONT_FAMILY, DEFAULT_RECORD_FONT_SIZE, DEFAULT_RECORD_THEME } from "./record-settings";
import {
  DEFAULT_STREAM_COLS,
  DEFAULT_STREAM_ROWS,
  MAX_STREAM_COLS,
  MAX_STREAM_ROWS,
  MIN_STREAM_COLS,
  MIN_STREAM_ROWS,
  parseLifetime,
  parseTerminalSize,
  printLinks,
  promptHidden,
  resolveServer,
} from "./util";
import { startControlServer } from "./control";

export interface StreamArgs extends TtylVaultCliArgs {
  server: string;
  viewOnly: boolean;
  lifetime: string;
  size: string;
  followTerminalSize: boolean;
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
  if (args.followTerminalSize && args.size.trim() !== "") {
    throw new Error("choose either --size or --follow-terminal-size, not both");
  }

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

  const fixedSize = parseTerminalSize(args.size) ?? {
    cols: DEFAULT_STREAM_COLS,
    rows: DEFAULT_STREAM_ROWS,
  };
  const hasExplicitSize = args.size.trim() !== "";
  // There is one canonical PTY grid. If the broadcaster has a terminal window,
  // it owns that grid and tracks its local size. Otherwise the stream uses the
  // explicit/default size. Browser geometry is handled only in the browser view
  // layer, so a web viewport can never change the PTY's wrap/cursor semantics.
  const followWindow = !hasExplicitSize && (args.followTerminalSize || process.stdout.isTTY === true);
  let cols = followWindow ? process.stdout.columns || fixedSize.cols : fixedSize.cols;
  let rows = followWindow ? process.stdout.rows || fixedSize.rows : fixedSize.rows;
  const command = args.command.length > 0 ? args.command : [process.env.SHELL || "/bin/sh"];
  const vaultSettings = resolveTtylVaultSettings(args, "ttyl-stream");
  const vault = await createTtylVaultWriter(vaultSettings, {
    command,
    cwd: process.cwd(),
    outputVideo: "",
    terminal: { cols, rows },
    recording: {
      preset: "stream",
      fps: 0,
      fontSize: DEFAULT_RECORD_FONT_SIZE,
      fontFamily: DEFAULT_RECORD_FONT_FAMILY,
      theme: DEFAULT_RECORD_THEME,
    },
  });

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
    // path as a normal exit. `cleanup` is declared below; this forward
    // reference is safe only because the closure is never invoked before
    // setup finishes, and nothing between here and its declaration awaits.
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

  function publishResize(): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encode({ kind: Kind.Resize, cols, rows }));
    }
  }

  function resizePty(nextCols: number, nextRows: number): void {
    if (!validResize(nextCols, nextRows)) {
      return;
    }
    if (nextCols === cols && nextRows === rows) {
      return;
    }
    cols = nextCols;
    rows = nextRows;
    try {
      term.resize(cols, rows);
    } catch {
      // ignore transient resize errors
    }
    publishResize();
    vault.writeResize(cols, rows);
  }

  // Broadcast the initial size before any output.
  publishResize();

  let closed = false;
  let vaultFinished = false;
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
    void (async () => {
      await vault.finish(code);
      vaultFinished = true;
      if (vault.enabled) {
        process.stderr.write(`ttyl: vaulted ${vault.dir}\n`);
      }
      // Give the final output a moment to flush to stdout and over the socket.
      setTimeout(() => process.exit(code), 50);
    })().catch(() => {
      if (!vaultFinished) {
        void vault.abort();
      }
      setTimeout(() => process.exit(code), 50);
    });
  };

  // PTY output: mirror locally and broadcast (raw bytes).
  term.onData((chunk: string | Buffer) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    process.stdout.write(buf);
    vault.writeData(buf);
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < SEND_BUFFER_CAP) {
      // The Uint8Array is a view over node-pty's (possibly pooled) Buffer; this
      // is safe only because encode() copies the bytes synchronously before the
      // PTY can reuse the chunk. encode() must keep copying its input.
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

  // When the broadcaster owns the grid, keep the PTY tracking the local window
  // so the terminal it is mirrored into never shows dead space. Each confirmed
  // size is published to viewers, which render the same source grid and scale
  // it visually without feeding browser geometry back into this PTY.
  if (followWindow) {
    process.stdout.on("resize", () => {
      resizePty(process.stdout.columns || cols, process.stdout.rows || rows);
    });
  }
}

function validResize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= MIN_STREAM_COLS &&
    rows >= MIN_STREAM_ROWS &&
    cols <= MAX_STREAM_COLS &&
    rows <= MAX_STREAM_ROWS
  );
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
