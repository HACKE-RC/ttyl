// Shared helpers for the streaming client: lifetime parsing, server resolution,
// and link printing.
import { load } from "./config";

export const DEFAULT_SERVER = "http://localhost:8080";
export const DEFAULT_STREAM_COLS = 80;
export const DEFAULT_STREAM_ROWS = 24;

// Bounds on a PTY grid, shared by --size parsing and live resize validation so
// the two can never disagree on what counts as a plausible terminal.
export const MIN_STREAM_COLS = 20;
export const MIN_STREAM_ROWS = 5;
export const MAX_STREAM_COLS = 500;
export const MAX_STREAM_ROWS = 200;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSizeSource {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export function terminalSizeFromTty(source: TerminalSizeSource, fallback: TerminalSize): TerminalSize {
  const cols = source.columns ?? 0;
  const rows = source.rows ?? 0;
  if (
    source.isTTY === true &&
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= MIN_STREAM_COLS &&
    rows >= MIN_STREAM_ROWS &&
    cols <= MAX_STREAM_COLS &&
    rows <= MAX_STREAM_ROWS
  ) {
    return { cols, rows };
  }
  return fallback;
}

// parseLifetime turns a --lifetime value into a ttl for the relay:
//   ""            -> undefined (omit ?ttl; the relay uses its default)
//   never|none|0  -> 0 (never expire)
//   30m|8h|2d|1d12h -> total seconds
// It throws on anything it cannot parse.
export function parseLifetime(input: string): number | undefined {
  const s = input.trim().toLowerCase();
  if (s === "") {
    return undefined;
  }
  if (s === "never" || s === "none" || s === "0") {
    return 0;
  }
  const re = /(\d+)(s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s)) !== null) {
    total += Number(match[1]) * UNIT_SECONDS[match[2]];
    consumed += match[0].length;
  }
  if (consumed !== s.length || total <= 0) {
    throw new Error(`invalid --lifetime "${input}": use values like 30m, 8h, 2d, or 'never'`);
  }
  return total;
}

// parseTerminalSize turns a --size value into a PTY geometry:
//   ""          -> undefined (caller uses the default)
//   80x24       -> { cols: 80, rows: 24 }
//   100X30      -> { cols: 100, rows: 30 }
// It throws on malformed or implausible values.
export function parseTerminalSize(input: string): TerminalSize | undefined {
  const s = input.trim().toLowerCase();
  if (s === "") {
    return undefined;
  }
  const match = /^(\d+)x(\d+)$/.exec(s);
  if (!match) {
    throw new Error(`invalid --size "${input}": use COLSxROWS, for example 80x24`);
  }
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < MIN_STREAM_COLS ||
    rows < MIN_STREAM_ROWS
  ) {
    throw new Error(`invalid --size "${input}": minimum size is ${MIN_STREAM_COLS}x${MIN_STREAM_ROWS}`);
  }
  if (cols > MAX_STREAM_COLS || rows > MAX_STREAM_ROWS) {
    throw new Error(`invalid --size "${input}": maximum size is ${MAX_STREAM_COLS}x${MAX_STREAM_ROWS}`);
  }
  return { cols, rows };
}

// validateServerURL asserts an http(s) URL with a host and returns it trimmed
// of a trailing slash.
export function validateServerURL(s: string): string {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`invalid server URL "${s}": expected http://host or https://host`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.hostname === "") {
    throw new Error(`invalid server URL "${s}": expected http://host or https://host`);
  }
  return s.replace(/\/+$/, "");
}

// resolveServer picks the relay URL: an explicit flag wins, then the saved
// config, then the built-in default (with a hint to run `ttyl init`).
export async function resolveServer(flagValue: string): Promise<string> {
  if (flagValue) {
    return validateServerURL(flagValue);
  }
  const cfg = await load();
  if (cfg.server) {
    return validateServerURL(cfg.server);
  }
  process.stderr.write(
    `ttyl: no -server given and none configured; using ${DEFAULT_SERVER}\n` +
      `ttyl: set a default with: ttyl init -server <url>\n`,
  );
  return DEFAULT_SERVER;
}

// linkLines builds the aligned link strings for a session. The read-write link
// carries the control key in its fragment and the dashboard link carries the
// admin key; --view-only suppresses the read-write link (a view-only stream
// still gets a dashboard so the owner can manage viewers).
export function linkLines(
  server: string,
  id: string,
  key: string,
  admin: string,
  viewOnly: boolean,
): string[] {
  const base = server.replace(/\/+$/, "");
  const lines: string[] = [];
  if (!viewOnly) {
    lines.push(`read-write: ${base}/s/${id}#${key}`);
  }
  lines.push(`view-only:  ${base}/s/${id}`);
  if (admin) {
    lines.push(`dashboard:  ${base}/admin/${id}#${admin}`);
  }
  return lines;
}

// printLinks writes the session's links at stream start, with a hint that they
// can be recovered later (they scroll off once the terminal mirror takes over).
export function printLinks(
  server: string,
  id: string,
  key: string,
  admin: string,
  viewOnly: boolean,
): void {
  const header = viewOnly ? "ttyl: streaming live (view-only)" : "ttyl: streaming live";
  const body = linkLines(server, id, key, admin, viewOnly)
    .map((l) => `  ${l}`)
    .join("\r\n");
  process.stderr.write(
    `${header}\r\n${body}\r\n` +
      `  (shown once; run \`ttyl links\` in another terminal to see them again)\r\n`,
  );
}

// promptHidden reads a single line from the terminal without echoing it, so a
// password never appears on screen or in shell history. On a non-TTY stdin it
// falls back to a plain line read.
export function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let buf = "";
    const isTty = Boolean(stdin.isTTY);
    const wasRaw = isTty ? stdin.isRaw : false;
    if (isTty) {
      stdin.setRawMode(true);
    }
    stdin.resume();

    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (isTty) {
        stdin.setRawMode(wasRaw);
      }
      stdin.pause();
    };
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stderr.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else if (ch >= " ") {
          buf += ch;
        }
      }
    };
    // EOF (piped/closed stdin) ends the prompt with whatever was entered, so the
    // stream does not hang waiting for a newline that will never come.
    const onEnd = (): void => {
      cleanup();
      resolve(buf);
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}
