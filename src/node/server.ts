// Node server adapter for the ttyl relay. It runs the same core Relay as the
// Cloudflare Worker, but hosts it as a long-lived HTTP + WebSocket server you
// can deploy on any VM, container, or PaaS. Sessions live in an in-memory
// registry; a timer enforces the TTL; a sliding-window counter rate limits
// session creation. Run with: npm run start  (PORT, SESSION_TTL_SECONDS env).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { Relay, type Conn, type ConnMeta, type Role } from "../core/relay";
import { hashPassword } from "../core/auth";
import { newSessionID } from "../core/base32";
import {
  ADMIN_PATH,
  CONNECT_GRACE_MS,
  CONTENT_TYPE,
  isAbandoned,
  parseTtlParam,
  resolveTtlSeconds,
  securityHeaders,
  VIEWER_PATH,
  WS_PATH,
} from "../core/http";
import {
  MAX_VAULT_UPLOAD_BYTES,
  validateVaultPayload,
  vaultPayloadSize,
  VAULT_API_ITEM_PATH,
  VAULT_API_EVENTS_PATH,
  VAULT_API_TRANSCRIPT_PATH,
  VAULT_VIEW_PATH,
  type VaultManifest,
  type VaultShareInfo,
} from "../core/vault";
import { flagValue } from "../args";
import indexHtml from "../../web/index.html";
import adminHtml from "../../web/admin.html";
import vaultHtml from "../../web/vault.html";
import viewerJs from "../../web/viewer.client.txt";
import adminJs from "../../web/admin.client.txt";
import vaultJs from "../../web/vault.client.txt";
import xtermJs from "../../web/vendor/xterm.lib.txt";
import xtermCss from "../../web/vendor/xterm.style.txt";

// The default session lifetime in ms (shared TTL policy; env-configurable).
const DEFAULT_TTL_MS = resolveTtlSeconds(undefined, process.env.SESSION_TTL_SECONDS) * 1000;
// Trust X-Forwarded-For for the client IP only when explicitly behind a proxy,
// so the header cannot be spoofed to bypass rate limiting on a direct listener.
const TRUST_PROXY = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true";
const RL_LIMIT = 20;
const RL_WINDOW_MS = 60_000;
// Cap the JSON body we read on session creation; the only field is an optional
// password, so this is generous.
const MAX_BODY_BYTES = 4 * 1024;

// Assets are embedded at build time (no third-party CDN, no runtime disk reads).
const ASSETS = {
  index: indexHtml,
  admin: adminHtml,
  vault: vaultHtml,
  viewer: viewerJs,
  adminJs,
  vaultJs,
  xtermJs,
  xtermCss,
};

interface Session {
  relay: Relay;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface VaultRecord {
  id: string;
  dir: string;
  manifest: VaultManifest;
  expiresAt: number | null;
  adminToken: string;
  viewToken: string;
  protected: boolean;
  ttlTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();
const vaults = new Map<string, VaultRecord>();
const rateHits = new Map<string, number[]>();

function dataDir(): string {
  const root =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
      : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(root, "ttyl", "hosted-vaults");
}

function vaultDir(id: string): string {
  return join(dataDir(), id);
}

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
    if (isAbandoned(relay.hasBroadcaster)) {
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
function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let bytes = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        over = true;
        data = "";
        return;
      }
      data += chunk.toString("utf8");
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

  if (method === "POST" && path === "/api/vaults") {
    return createVault(req, res, url);
  }

  if (method === "DELETE") {
    const vaultApiMatch = path.match(VAULT_API_ITEM_PATH);
    if (vaultApiMatch) {
      return deleteVault(req, res, vaultApiMatch[1]);
    }
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
    if (path === "/static/vault.js") {
      return secured(res, 200, CONTENT_TYPE.js, ASSETS.vaultJs);
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
    const vaultMatch = path.match(VAULT_VIEW_PATH);
    if (vaultMatch) {
      if (!(await liveVault(vaultMatch[1]))) {
        return secured(res, 404, CONTENT_TYPE.text, "vault not found");
      }
      return secured(res, 200, CONTENT_TYPE.html, ASSETS.vault);
    }
    const vaultApiMatch = path.match(VAULT_API_ITEM_PATH);
    if (vaultApiMatch) {
      const record = await liveVault(vaultApiMatch[1]);
      if (!record || !canViewVault(req, record)) {
        return secured(res, 404, CONTENT_TYPE.text, "vault not found");
      }
      return secured(res, 200, CONTENT_TYPE.json, JSON.stringify(vaultInfo(record)));
    }
    const vaultEventsMatch = path.match(VAULT_API_EVENTS_PATH);
    if (vaultEventsMatch) {
      const record = await liveVault(vaultEventsMatch[1]);
      if (!record || !canViewVault(req, record)) {
        return secured(res, 404, CONTENT_TYPE.text, "vault not found");
      }
      return sendVaultFile(res, join(record.dir, "events.jsonl"), "application/x-ndjson; charset=utf-8");
    }
    const vaultTranscriptMatch = path.match(VAULT_API_TRANSCRIPT_PATH);
    if (vaultTranscriptMatch) {
      const record = await liveVault(vaultTranscriptMatch[1]);
      if (!record || !canViewVault(req, record)) {
        return secured(res, 404, CONTENT_TYPE.text, "vault not found");
      }
      return sendVaultFile(res, join(record.dir, "transcript.txt"), CONTENT_TYPE.text);
    }
  }

  return secured(res, 404, CONTENT_TYPE.text, "not found");
}

async function createVault(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!allow(clientIp(req))) {
    return secured(res, 429, CONTENT_TYPE.text, "rate limit exceeded");
  }
  const body = await readBody(req, MAX_VAULT_UPLOAD_BYTES + 1);
  if (body === "") {
    return secured(res, 400, CONTENT_TYPE.text, "empty or oversized vault");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return secured(res, 400, CONTENT_TYPE.text, "invalid vault json");
  }
  const payload = validateVaultPayload(parsed);
  if (!payload || vaultPayloadSize(payload) > MAX_VAULT_UPLOAD_BYTES) {
    return secured(res, 400, CONTENT_TYPE.text, "invalid vault payload");
  }
  const id = newSessionID();
  const adminToken = newSessionID();
  const privateShare = url.searchParams.get("private") === "1";
  const viewToken = privateShare ? newSessionID() : "";
  const ttl = resolveTtlSeconds(parseTtlParam(url.searchParams.get("ttl")), process.env.SESSION_TTL_SECONDS);
  const expiresAt = ttl <= 0 ? null : Date.now() + ttl * 1000;
  const dir = vaultDir(id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(payload.manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(dir, "events.jsonl"), payload.events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
    mode: 0o600,
  });
  await writeFile(join(dir, "transcript.txt"), payload.transcript, { mode: 0o600 });
  const record: VaultRecord = {
    id,
    dir,
    manifest: payload.manifest,
    expiresAt,
    adminToken,
    viewToken,
    protected: privateShare,
    ttlTimer: expiresAt === null ? null : setTimeout(() => void removeHostedVault(id), ttl * 1000),
  };
  await writeFile(join(dir, "share.json"), `${JSON.stringify(serializeVaultRecord(record), null, 2)}\n`, { mode: 0o600 });
  vaults.set(id, record);
  const link = `${requestOrigin(req)}/v/${id}${privateShare ? `#${viewToken}` : ""}`;
  const response = {
    id,
    link,
    adminLink: `${requestOrigin(req)}/v/${id}#admin=${adminToken}`,
    adminToken,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    protected: privateShare,
  };
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPE.json,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(response));
}

async function deleteVault(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const record = await liveVault(id);
  if (!record || !canAdminVault(req, record)) {
    return secured(res, 404, CONTENT_TYPE.text, "vault not found");
  }
  await removeHostedVault(id);
  return secured(res, 200, CONTENT_TYPE.json, JSON.stringify({ deleted: true }));
}

async function liveVault(id: string): Promise<VaultRecord | undefined> {
  const record = vaults.get(id) ?? (await loadHostedVault(id));
  if (!record) {
    return undefined;
  }
  if (record.expiresAt !== null && Date.now() > record.expiresAt) {
    await removeHostedVault(id);
    return undefined;
  }
  return record;
}

async function loadHostedVault(id: string): Promise<VaultRecord | undefined> {
  try {
    const dir = vaultDir(id);
    const stored = JSON.parse(await readFile(join(dir, "share.json"), "utf8")) as Omit<VaultRecord, "ttlTimer">;
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as VaultManifest;
    const record: VaultRecord = {
      ...stored,
      dir,
      manifest,
      ttlTimer:
        stored.expiresAt === null
          ? null
          : setTimeout(() => void removeHostedVault(id), Math.max(1, stored.expiresAt - Date.now())),
    };
    vaults.set(id, record);
    return record;
  } catch {
    return undefined;
  }
}

async function removeHostedVault(id: string): Promise<void> {
  const record = vaults.get(id);
  if (record?.ttlTimer) {
    clearTimeout(record.ttlTimer);
  }
  vaults.delete(id);
  await rm(vaultDir(id), { recursive: true, force: true });
}

async function sendVaultFile(res: ServerResponse, path: string, contentType: string): Promise<void> {
  try {
    const body = await readFile(path, "utf8");
    secured(res, 200, contentType, body);
  } catch {
    secured(res, 404, CONTENT_TYPE.text, "vault not found");
  }
}

function serializeVaultRecord(record: VaultRecord): Omit<VaultRecord, "ttlTimer"> {
  return {
    id: record.id,
    dir: record.dir,
    manifest: record.manifest,
    expiresAt: record.expiresAt,
    adminToken: record.adminToken,
    viewToken: record.viewToken,
    protected: record.protected,
  };
}

function vaultInfo(record: VaultRecord): VaultShareInfo {
  return {
    id: record.id,
    manifest: record.manifest,
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    protected: record.protected,
  };
}

function canViewVault(req: IncomingMessage, record: VaultRecord): boolean {
  if (!record.protected) {
    return true;
  }
  const token = bearerToken(req);
  return token === record.viewToken || token === record.adminToken;
}

function canAdminVault(req: IncomingMessage, record: VaultRecord): boolean {
  return bearerToken(req) === record.adminToken;
}

function bearerToken(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") {
    return "";
  }
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : "";
}

function requestOrigin(req: IncomingMessage): string {
  const proto =
    TRUST_PROXY && typeof req.headers["x-forwarded-proto"] === "string"
      ? req.headers["x-forwarded-proto"].split(",")[0].trim()
      : "http";
  return `${proto}://${req.headers.host ?? "localhost"}`;
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
