// Shared helpers for the streaming client: lifetime parsing, server resolution,
// and link printing.
import { load } from "./config";

export const DEFAULT_SERVER = "http://localhost:8080";

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

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
    return cfg.server;
  }
  process.stderr.write(
    `ttyl: no -server given and none configured; using ${DEFAULT_SERVER}\n` +
      `ttyl: set a default with: ttyl init -server <url>\n`,
  );
  return DEFAULT_SERVER;
}

// printLinks writes the shareable session URLs. The read-write link carries the
// control key in its fragment; --view-only suppresses it.
export function printLinks(server: string, id: string, key: string, viewOnly: boolean): void {
  const base = server.replace(/\/+$/, "");
  if (viewOnly) {
    process.stderr.write(`ttyl: streaming live (view-only)\r\n  view-only: ${base}/s/${id}\r\n`);
    return;
  }
  process.stderr.write(
    `ttyl: streaming live\r\n` +
      `  read-write: ${base}/s/${id}#${key}\r\n` +
      `  view-only:  ${base}/s/${id}\r\n`,
  );
}
