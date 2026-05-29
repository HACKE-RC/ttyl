// Node server adapter for the ttyl relay. It runs the same core Relay as the
// Cloudflare Worker, but hosts it as a long-lived HTTP + WebSocket server you
// can deploy on any VM, container, or PaaS. Sessions live in an in-memory
// registry; a timer enforces the TTL; a sliding-window counter rate limits
// session creation. Run with: npm run start  (PORT, SESSION_TTL_SECONDS env).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { Relay, type Conn, type ConnMeta, type Role } from "../core/relay";
import { hashPassword } from "../core/auth";
import { newSessionID } from "../core/base32";
import {
  ADMIN_PATH,
  CONTENT_TYPE,
  parseTtlParam,
  resolveTtlSeconds,
  securityHeaders,
  VIEWER_PATH,
  WS_PATH,
} from "../core/http";
import { flagValue } from "../args";
import indexHtml from "../../web/index.html";
import adminHtml from "../../web/admin.html";
import viewerJs from "../../web/viewer.client.txt";
import adminJs from "../../web/admin.client.txt";
import xtermJs from "../../web/vendor/xterm.lib.txt";
import xtermCss from "../../web/vendor/xterm.style.txt";

// The default session lifetime in ms (shared TTL policy; env-configurable).
const DEFAULT_TTL_MS = resolveTtlSeconds(undefined, process.env.SESSION_TTL_SECONDS) * 1000;
// Trust X-Forwarded-For for the client IP only when explicitly behind a proxy,
// so the header cannot be spoofed to bypass rate limiting on a direct listener.
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
const RL_LIMIT = 20;
const RL_WINDOW_MS = 60_000;
// A session never streamed to within this window is reaped (bounds abandoned
// "never expire" sessions).
const CONNECT_GRACE_MS = 2 * 60 * 1000;
// Cap the JSON body we read on session creation; the only field is an optional
// password, so this is generous.
const MAX_BODY_BYTES = 4 * 1024;

// Assets are embedded at build time (no third-party CDN, no runtime disk reads).
const ASSETS = {
  index: indexHtml,
  admin: adminHtml,
  viewer: viewerJs,
  adminJs,
  xtermJs,
  xtermCss,
};

interface Session {
  relay: Relay;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();
const rateHits = new Map<string, number[]>();

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) {
      return fwd.split(",")[0].trim();
    }
  }
  return req.socket.remoteAddress ?? "anon";
}

function allow(ip: string): boolean {
  const now = Date.now();
  const recent = (rateHits.get(ip) ?? []).filter((t) => now - t < RL_WINDOW_MS);
  if (recent.length >= RL_LIMIT) {
    rateHits.set(ip, recent);
    return false;
  }
  recent.push(now);
  rateHits.set(ip, recent);
  return true;
}

// Drop rate-limit buckets with no recent hits so the map cannot grow without
// bound across many distinct client IPs. Scheduled by startServer.
function evictStaleRateHits(): void {
  const cutoff = Date.now() - RL_WINDOW_MS;
  for (const [ip, hits] of rateHits) {
    if (hits.every((t) => t <= cutoff)) {
      rateHits.delete(ip);
    }
  }
}

function secured(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, securityHeaders(contentType));
  res.end(body);
}

// createSession starts a session. ttlOverrideSeconds comes from ?ttl=:
// undefined uses the server default, NEVER_TTL never expires, a positive value
// is the per-session lifetime in seconds. An optional initial password is
// hashed (never stored in plaintext). Every session also gets a connect grace
// so one that is never streamed to is reaped.
async function createSession(
  ttlOverrideSeconds: number | undefined,
  password: string | undefined,
): Promise<{ id: string; key: string; admin: string }> {
  const id = newSessionID();
  const key = newSessionID();
  const admin = newSessionID();
  const hashed = password ? await hashPassword(password) : null;

  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const relay = new Relay({
    controlKey: key,
    adminKey: admin,
    password: hashed,
    locked: false,
    onEnd: () => {
      if (ttlTimer) clearTimeout(ttlTimer);
      if (graceTimer) clearTimeout(graceTimer);
      sessions.delete(id);
    },
    // In-memory adapter: management state lives in the resident Relay, so there
    // is nothing to persist across lifetimes.
    onPersist: () => {},
  });

  // NEVER_TTL (0) means no expiry timer; undefined uses the server default;
  // a positive value is the per-session lifetime in seconds.
  const ttlMs = ttlOverrideSeconds === undefined ? DEFAULT_TTL_MS : ttlOverrideSeconds * 1000;
  if (ttlMs > 0) {
    ttlTimer = setTimeout(() => relay.end(), ttlMs);
  }
  // Reap a session that is never streamed to (covers abandoned "never" sessions).
  graceTimer = setTimeout(() => {
    if (!relay.hasBroadcaster) {
      relay.end();
    }
  }, CONNECT_GRACE_MS);

  sessions.set(id, { relay, ttlTimer, graceTimer });
  return { id, key, admin };
}

function live(id: string): Session | undefined {
  const s = sessions.get(id);
  return s && !s.relay.ended ? s : undefined;
}

// readBody collects a bounded request body, returning "" if it is missing or
// over the cap.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      data += chunk.toString("utf8");
      if (data.length > MAX_BODY_BYTES) {
        over = true;
        data = "";
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function parsePassword(body: string): string | undefined {
  if (body === "") {
    return undefined;
  }
  try {
    const obj = JSON.parse(body) as { password?: unknown };
    return typeof obj.password === "string" && obj.password !== "" ? obj.password : undefined;
  } catch {
    return undefined;
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (method === "POST" && path === "/api/sessions") {
    if (!allow(clientIp(req))) {
      return secured(res, 429, CONTENT_TYPE.text, "rate limit exceeded");
    }
    const password = parsePassword(await readBody(req));
    const { id, key, admin } = await createSession(
      parseTtlParam(url.searchParams.get("ttl")),
      password,
    );
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPE.json,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ id, key, admin }));
    return;
  }

  if (method === "GET") {
    if (path === "/") {
      return secured(
        res,
        200,
        CONTENT_TYPE.text,
        "ttyl relay server. Start a stream with: ttyl stream\n",
      );
    }
    if (path === "/static/viewer.js") {
      return secured(res, 200, CONTENT_TYPE.js, ASSETS.viewer);
    }
    if (path === "/static/admin.js") {
      return secured(res, 200, CONTENT_TYPE.js, ASSETS.adminJs);
    }
    if (path === "/static/xterm.js") {
      return secured(res, 200, CONTENT_TYPE.js, ASSETS.xtermJs);
    }
    if (path === "/static/xterm.css") {
      return secured(res, 200, CONTENT_TYPE.css, ASSETS.xtermCss);
    }
    const viewerMatch = path.match(VIEWER_PATH);
    if (viewerMatch) {
      if (!live(viewerMatch[1])) {
        return secured(res, 404, CONTENT_TYPE.text, "session not found");
      }
      return secured(res, 200, CONTENT_TYPE.html, ASSETS.index);
    }
    const adminMatch = path.match(ADMIN_PATH);
    if (adminMatch) {
      if (!live(adminMatch[1])) {
        return secured(res, 404, CONTENT_TYPE.text, "session not found");
      }
      return secured(res, 200, CONTENT_TYPE.html, ASSETS.admin);
    }
  }

  return secured(res, 404, CONTENT_TYPE.text, "not found");
}

function bridge(ws: WebSocket, relay: Relay, role: Role, meta: ConnMeta): void {
  const conn: Conn = {
    role,
    authed: false,
    writer: false,
    id: "",
    meta,
    send: (d) => {
      try {
        ws.send(d);
      } catch {
        // socket closing
      }
    },
    sendText: (t) => {
      try {
        ws.send(t);
      } catch {
        // socket closing
      }
    },
    close: (c, r) => {
      try {
        ws.close(c, r);
      } catch {
        // already closing
      }
    },
  };
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (role === "admin") {
      // Admins speak the JSON control plane (text frames) only.
      if (!isBinary) {
        relay.controlMessage(conn, data.toString("utf8"));
      }
      return;
    }
    if (!isBinary) {
      return;
    }
    relay.message(conn, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  });
  ws.on("close", () => relay.close(conn));
  ws.on("error", () => relay.close(conn));
}

// startServer constructs and binds the relay. Doing all construction here (not
// at import time) means importing this module has no side effects, so the CLI's
// other commands don't spin up an HTTP/WebSocket server. Port/host come from CLI
// flags (--port/-p, --host/-H) or the PORT/HOST env vars; flags win.
export function startServer(argv: string[] = process.argv.slice(2)): void {
  const port = Number(flagValue(argv, "--port", "-p") ?? process.env.PORT) || 8080;
  const host = flagValue(argv, "--host", "-H") ?? process.env.HOST ?? "0.0.0.0";

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      try {
        secured(res, 500, CONTENT_TYPE.text, "internal error");
      } catch {
        // response already sent
      }
    });
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = (req.url ?? "").split("?")[0].match(WS_PATH);
    const session = match ? live(match[1]) : undefined;
    if (!match || !session) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const role: Role =
      match[2] === "broadcast" ? "broadcaster" : match[2] === "admin" ? "admin" : "viewer";
    const ua = req.headers["user-agent"];
    const meta: ConnMeta = { ip: clientIp(req), ua: typeof ua === "string" ? ua : undefined };
    wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, session.relay, role, meta));
  });

  setInterval(evictStaleRateHits, RL_WINDOW_MS).unref();

  server.listen(port, host, () => {
    console.log(`ttyl relay (node) listening on http://${host}:${port}`);
  });
}
