// Cloudflare Worker adapter for the ttyl relay. The stateless Worker routes
// requests; one Durable Object per session id holds a core Relay in memory and
// bridges real WebSockets to it. Sockets use the classic accept() API so the
// Durable Object stays resident (and its Relay state intact) while a session is
// live; lifecycle state is persisted so the session survives the brief gap
// between creation and the first connection, and so its 404-after-end, TTL, and
// management (admin key / password / lock) semantics hold across evictions.
import { DurableObject } from "cloudflare:workers";
import { Relay, type Conn, type PersistState, type Role } from "../core/relay";
import { hashPassword, type StoredPassword } from "../core/auth";
import { newSessionID } from "../core/base32";
import {
  CONNECT_GRACE_MS,
  CONTENT_TYPE,
  isAbandoned,
  parseTtlParam,
  resolveTtlSeconds,
  securityHeaders,
  ADMIN_PATH,
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
import indexHtml from "../../web/index.html";
import adminHtml from "../../web/admin.html";
import vaultHtml from "../../web/vault.html";
import viewerJs from "../../web/viewer.client.txt";
import adminJs from "../../web/admin.client.txt";
import vaultJs from "../../web/vault.client.txt";
import xtermJs from "../../web/vendor/xterm.lib.txt";
import xtermCss from "../../web/vendor/xterm.style.txt";

const KEY_CREATED = "created";
const KEY_ENDED = "ended";
const KEY_CONTROL = "key";
const KEY_ADMIN = "admin";
const KEY_NEVER = "never";
const KEY_LOCKED = "locked";
const KEY_PWHASH = "pwhash";
const KEY_PWSALT = "pwsalt";
const KEY_PWITER = "pwiter";
const KEY_VAULT_PREFIX = "prefix";
const KEY_VAULT_MANIFEST = "manifest";
const KEY_VAULT_EXPIRES = "expires";
const KEY_VAULT_ADMIN = "admin-token";
const KEY_VAULT_VIEW = "view-token";
const KEY_VAULT_PROTECTED = "protected";

export interface Env {
  SESSION: DurableObjectNamespace<SessionRelay>;
  VAULT: DurableObjectNamespace<VaultArchive>;
  VAULT_OBJECTS: R2Bucket;
  SESSION_LIMITER?: RateLimit;
  SESSION_TTL_SECONDS?: string;
}

export class SessionRelay extends DurableObject<Env> {
  private relay: Relay | null = null;
  private created = false;
  private ended = false;
  private never = false;
  private controlKey = "";
  private adminKey = "";
  private password: StoredPassword | null = null;
  private locked = false;
  private loaded = false;
  private ending = false;
  // Persists run through one chain so concurrent management changes commit to
  // storage in call order, and a failed write is logged rather than swallowed.
  private persistTail: Promise<void> = Promise.resolve();

  // create marks the session live and arms its expiry. ttlOverride (seconds)
  // comes from the client's --lifetime: 0 means never expire (no alarm), a
  // positive value is clamped, and undefined falls back to the server default.
  // An optional initial password is hashed here; the plaintext is never stored.
  async create(
    controlKey: string,
    adminKey: string,
    password: string | undefined,
    ttlOverride?: number,
  ): Promise<void> {
    await this.ensureLoaded();
    // create runs exactly once per session id (the id is freshly random, so the
    // Durable Object is always brand new here). Guard anyway so a stray repeat
    // can never clobber the live keys or resurrect a session that already ended.
    if (this.created) {
      return;
    }
    this.created = true;
    this.controlKey = controlKey;
    this.adminKey = adminKey;
    await this.ctx.storage.put(KEY_CREATED, true);
    await this.ctx.storage.put(KEY_CONTROL, controlKey);
    await this.ctx.storage.put(KEY_ADMIN, adminKey);
    if (password) {
      this.password = await hashPassword(password);
      await this.storePassword(this.password);
    }
    const ttl = resolveTtlSeconds(ttlOverride, this.env.SESSION_TTL_SECONDS);
    this.never = ttl <= 0;
    await this.ctx.storage.put(KEY_NEVER, this.never);
    // TTL sessions expire at the TTL. "Never" sessions still get a short grace
    // alarm so one that is never connected to gets reaped instead of lingering.
    const delayMs = this.never ? CONNECT_GRACE_MS : ttl * 1000;
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  async exists(): Promise<boolean> {
    await this.ensureLoaded();
    return this.created && !this.ended;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (this.ended || !this.created) {
      return new Response("session ended", { status: 404 });
    }

    const pathname = new URL(request.url).pathname;
    const role: Role = pathname.endsWith("/broadcast")
      ? "broadcaster"
      : pathname.endsWith("/admin")
        ? "admin"
        : "viewer";

    const relay = this.ensureRelay();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const conn: Conn = {
      role,
      authed: false,
      writer: false,
      id: "",
      meta: {
        ip: request.headers.get("CF-Connecting-IP") ?? undefined,
        ua: request.headers.get("User-Agent") ?? undefined,
      },
      send: (d) => {
        try {
          server.send(d);
        } catch {
          // socket closing
        }
      },
      sendText: (t) => {
        try {
          server.send(t);
        } catch {
          // socket closing
        }
      },
      close: (c, r) => {
        try {
          server.close(c, r);
        } catch {
          // already closing
        }
      },
    };

    server.addEventListener("message", (e) => {
      if (role === "admin") {
        // Admins speak the JSON control plane (text frames) only.
        if (typeof e.data === "string") {
          relay.controlMessage(conn, e.data);
        }
        return;
      }
      if (typeof e.data === "string") {
        return;
      }
      relay.message(conn, new Uint8Array(e.data as ArrayBuffer));
    });
    server.addEventListener("close", () => relay.close(conn));
    server.addEventListener("error", () => relay.close(conn));

    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    // For a "never expire" session, the alarm is only the connect grace: unless
    // the session has been abandoned (no live broadcaster) leave it running (and
    // set no new alarm, so it truly never expires); otherwise reap it.
    if (this.never && !isAbandoned(this.relay?.hasBroadcaster ?? false)) {
      return;
    }
    if (this.relay) {
      this.relay.end();
    } else {
      await this.handleEnd();
    }
  }

  private ensureRelay(): Relay {
    if (!this.relay) {
      this.relay = new Relay({
        controlKey: this.controlKey,
        adminKey: this.adminKey,
        password: this.password,
        locked: this.locked,
        onEnd: () => {
          this.handleEnd().catch((e) => console.error("ttyl: session end failed", e));
        },
        onPersist: (s) => {
          if (this.ending || this.ended) {
            return;
          }
          this.persistTail = this.persistTail
            .then(() => this.handlePersist(s))
            .catch((e) => console.error("ttyl: persist failed", e));
        },
      });
    }
    return this.relay;
  }

  // handlePersist mirrors live management state (password, lock) into storage so
  // it survives a Durable Object eviction between in-memory lifetimes.
  private async handlePersist(state: PersistState): Promise<void> {
    if (this.ending || this.ended) {
      return;
    }
    this.password = state.password;
    this.locked = state.locked;
    await this.storePassword(state.password);
    await this.ctx.storage.put(KEY_LOCKED, state.locked);
  }

  private async storePassword(pw: StoredPassword | null): Promise<void> {
    if (pw) {
      await this.ctx.storage.put(KEY_PWHASH, pw.hash);
      await this.ctx.storage.put(KEY_PWSALT, pw.salt);
      await this.ctx.storage.put(KEY_PWITER, pw.iter);
    } else {
      await this.ctx.storage.delete([KEY_PWHASH, KEY_PWSALT, KEY_PWITER]);
    }
  }

  private async handleEnd(): Promise<void> {
    if (this.ended || this.ending) {
      return;
    }
    this.ending = true;
    await this.persistTail.catch((e) => console.error("ttyl: persist before end failed", e));
    this.ended = true;
    this.relay = null;
    this.controlKey = "";
    this.adminKey = "";
    this.password = null;
    this.locked = false;
    await this.ctx.storage.put(KEY_ENDED, true);
    await this.ctx.storage.delete([
      KEY_CONTROL,
      KEY_ADMIN,
      KEY_NEVER,
      KEY_LOCKED,
      KEY_PWHASH,
      KEY_PWSALT,
      KEY_PWITER,
    ]);
    await this.ctx.storage.deleteAlarm();
    this.ending = false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const stored = await this.ctx.storage.get<boolean | string | number>([
      KEY_CREATED,
      KEY_ENDED,
      KEY_CONTROL,
      KEY_ADMIN,
      KEY_NEVER,
      KEY_LOCKED,
      KEY_PWHASH,
      KEY_PWSALT,
      KEY_PWITER,
    ]);
    this.created = stored.get(KEY_CREATED) === true;
    this.ended = stored.get(KEY_ENDED) === true;
    this.never = stored.get(KEY_NEVER) === true;
    this.locked = stored.get(KEY_LOCKED) === true;
    const key = stored.get(KEY_CONTROL);
    if (typeof key === "string") {
      this.controlKey = key;
    }
    const admin = stored.get(KEY_ADMIN);
    if (typeof admin === "string") {
      this.adminKey = admin;
    }
    const hash = stored.get(KEY_PWHASH);
    const salt = stored.get(KEY_PWSALT);
    const iter = stored.get(KEY_PWITER);
    if (typeof hash === "string" && typeof salt === "string" && typeof iter === "number") {
      this.password = { hash, salt, iter };
    }
    this.loaded = true;
  }
}

export class VaultArchive extends DurableObject<Env> {
  async create(meta: {
    manifest: VaultManifest;
    expiresAt: number | null;
    adminToken: string;
    viewToken: string;
    protected: boolean;
    prefix: string;
  }): Promise<void> {
    const existing = await this.ctx.storage.get(KEY_VAULT_PREFIX);
    if (existing !== undefined) {
      return;
    }
    await this.ctx.storage.put(KEY_VAULT_PREFIX, meta.prefix);
    await this.ctx.storage.put(KEY_VAULT_MANIFEST, meta.manifest);
    await this.ctx.storage.put(KEY_VAULT_EXPIRES, meta.expiresAt);
    await this.ctx.storage.put(KEY_VAULT_ADMIN, meta.adminToken);
    await this.ctx.storage.put(KEY_VAULT_VIEW, meta.viewToken);
    await this.ctx.storage.put(KEY_VAULT_PROTECTED, meta.protected);
    if (meta.expiresAt !== null) {
      await this.ctx.storage.setAlarm(meta.expiresAt);
    }
  }

  async exists(): Promise<boolean> {
    const prefix = await this.ctx.storage.get<string>(KEY_VAULT_PREFIX);
    if (!prefix) {
      return false;
    }
    const expiresAt = await this.ctx.storage.get<number | null>(KEY_VAULT_EXPIRES);
    if (expiresAt !== null && expiresAt !== undefined && Date.now() > expiresAt) {
      await this.clear();
      return false;
    }
    return true;
  }

  async info(token: string): Promise<VaultShareInfo | null> {
    if (!(await this.exists())) {
      return null;
    }
    const manifest = await this.ctx.storage.get<VaultManifest>(KEY_VAULT_MANIFEST);
    if (!manifest || !(await this.canView(token))) {
      return null;
    }
    const expiresAt = await this.ctx.storage.get<number | null>(KEY_VAULT_EXPIRES);
    return {
      id: this.ctx.id.toString(),
      manifest,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      protected: (await this.ctx.storage.get<boolean>(KEY_VAULT_PROTECTED)) === true,
    };
  }

  async readFile(name: "events.jsonl" | "transcript.txt", token: string): Promise<string | null> {
    if (!(await this.exists()) || !(await this.canView(token))) {
      return null;
    }
    const prefix = await this.ctx.storage.get<string>(KEY_VAULT_PREFIX);
    if (!prefix) {
      return null;
    }
    const object = await this.env.VAULT_OBJECTS.get(`${prefix}/${name}`);
    return object ? object.text() : null;
  }

  async revoke(token: string): Promise<boolean> {
    const adminToken = await this.ctx.storage.get<string>(KEY_VAULT_ADMIN);
    if (!adminToken || token !== adminToken) {
      return false;
    }
    await this.clear();
    return true;
  }

  override async alarm(): Promise<void> {
    await this.clear();
  }

  private async clear(): Promise<void> {
    const prefix = await this.ctx.storage.get<string>(KEY_VAULT_PREFIX);
    if (prefix) {
      await Promise.all([
        this.env.VAULT_OBJECTS.delete(`${prefix}/manifest.json`),
        this.env.VAULT_OBJECTS.delete(`${prefix}/events.jsonl`),
        this.env.VAULT_OBJECTS.delete(`${prefix}/transcript.txt`),
      ]);
    }
    await this.ctx.storage.delete([
      KEY_VAULT_PREFIX,
      KEY_VAULT_MANIFEST,
      KEY_VAULT_EXPIRES,
      KEY_VAULT_ADMIN,
      KEY_VAULT_VIEW,
      KEY_VAULT_PROTECTED,
    ]);
    await this.ctx.storage.deleteAlarm();
  }

  private async canView(token: string): Promise<boolean> {
    const protectedVault = (await this.ctx.storage.get<boolean>(KEY_VAULT_PROTECTED)) === true;
    if (!protectedVault) {
      return true;
    }
    const viewToken = await this.ctx.storage.get<string>(KEY_VAULT_VIEW);
    const adminToken = await this.ctx.storage.get<string>(KEY_VAULT_ADMIN);
    return token !== "" && (token === viewToken || token === adminToken);
  }
}

function secured(body: BodyInit | null, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: securityHeaders(contentType) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path === "/api/sessions") {
      return createSession(request, env);
    }

    if (request.method === "POST" && path === "/api/vaults") {
      return createVault(request, env);
    }

    if (request.method === "DELETE") {
      const vaultApiMatch = path.match(VAULT_API_ITEM_PATH);
      if (vaultApiMatch) {
        return revokeVault(request, env, vaultApiMatch[1]);
      }
    }

    if (request.method === "GET") {
      if (path === "/") {
        return secured(
          "ttyl relay server. Start a stream with: ttyl stream\n",
          CONTENT_TYPE.text,
        );
      }
      if (path === "/static/viewer.js") {
        return secured(viewerJs, CONTENT_TYPE.js);
      }
      if (path === "/static/admin.js") {
        return secured(adminJs, CONTENT_TYPE.js);
      }
      if (path === "/static/vault.js") {
        return secured(vaultJs, CONTENT_TYPE.js);
      }
      if (path === "/static/xterm.js") {
        return secured(xtermJs, CONTENT_TYPE.js);
      }
      if (path === "/static/xterm.css") {
        return secured(xtermCss, CONTENT_TYPE.css);
      }

      const viewerMatch = path.match(VIEWER_PATH);
      if (viewerMatch) {
        return sessionPage(env, viewerMatch[1], indexHtml);
      }

      const adminMatch = path.match(ADMIN_PATH);
      if (adminMatch) {
        return sessionPage(env, adminMatch[1], adminHtml);
      }

      const vaultMatch = path.match(VAULT_VIEW_PATH);
      if (vaultMatch) {
        return vaultPage(env, vaultMatch[1]);
      }

      const vaultApiMatch = path.match(VAULT_API_ITEM_PATH);
      if (vaultApiMatch) {
        return vaultJson(env, vaultApiMatch[1], request);
      }

      const vaultEventsMatch = path.match(VAULT_API_EVENTS_PATH);
      if (vaultEventsMatch) {
        return vaultFile(request, env, vaultEventsMatch[1], "events.jsonl", "application/x-ndjson; charset=utf-8");
      }

      const vaultTranscriptMatch = path.match(VAULT_API_TRANSCRIPT_PATH);
      if (vaultTranscriptMatch) {
        return vaultFile(request, env, vaultTranscriptMatch[1], "transcript.txt", CONTENT_TYPE.text);
      }

      const wsMatch = path.match(WS_PATH);
      if (wsMatch) {
        return websocket(env, request, wsMatch[1]);
      }
    }

    return secured("not found", CONTENT_TYPE.text, 404);
  },
} satisfies ExportedHandler<Env>;

async function createSession(request: Request, env: Env): Promise<Response> {
  if (env.SESSION_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "anon";
    const { success } = await env.SESSION_LIMITER.limit({ key: `create:${ip}` });
    if (!success) {
      return secured("rate limit exceeded", CONTENT_TYPE.text, 429);
    }
  }

  const id = newSessionID();
  const key = newSessionID();
  const admin = newSessionID();
  const ttl = parseTtlParam(new URL(request.url).searchParams.get("ttl"));
  const password = await readInitialPassword(request);
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  await stub.create(key, admin, password, ttl);

  return new Response(JSON.stringify({ id, key, admin }), {
    headers: {
      "Content-Type": CONTENT_TYPE.json,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

async function createVault(request: Request, env: Env): Promise<Response> {
  if (env.SESSION_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "anon";
    const { success } = await env.SESSION_LIMITER.limit({ key: `vault:${ip}` });
    if (!success) {
      return secured("rate limit exceeded", CONTENT_TYPE.text, 429);
    }
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_VAULT_UPLOAD_BYTES) {
    return secured("vault too large", CONTENT_TYPE.text, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return secured("invalid vault json", CONTENT_TYPE.text, 400);
  }
  const payload = validateVaultPayload(parsed);
  if (!payload || vaultPayloadSize(payload) > MAX_VAULT_UPLOAD_BYTES) {
    return secured("invalid vault payload", CONTENT_TYPE.text, 400);
  }

  const id = newSessionID();
  const adminToken = newSessionID();
  const privateShare = new URL(request.url).searchParams.get("private") === "1";
  const viewToken = privateShare ? newSessionID() : "";
  const ttl = resolveTtlSeconds(parseTtlParam(new URL(request.url).searchParams.get("ttl")), env.SESSION_TTL_SECONDS);
  const expiresAt = ttl <= 0 ? null : Date.now() + ttl * 1000;
  const prefix = `vaults/${id}`;
  await Promise.all([
    env.VAULT_OBJECTS.put(`${prefix}/manifest.json`, JSON.stringify(payload.manifest, null, 2)),
    env.VAULT_OBJECTS.put(`${prefix}/events.jsonl`, payload.events.map((event) => JSON.stringify(event)).join("\n") + "\n"),
    env.VAULT_OBJECTS.put(`${prefix}/transcript.txt`, payload.transcript),
  ]);
  const stub = env.VAULT.get(env.VAULT.idFromName(id));
  await stub.create({
    manifest: payload.manifest,
    expiresAt,
    adminToken,
    viewToken,
    protected: privateShare,
    prefix,
  });
  const origin = new URL(request.url).origin;
  const link = `${origin}/v/${id}${privateShare ? `#${viewToken}` : ""}`;
  return new Response(JSON.stringify({
    id,
    link,
    adminLink: `${origin}/v/${id}#admin=${adminToken}`,
    adminToken,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    protected: privateShare,
  }), {
    headers: {
      "Content-Type": CONTENT_TYPE.json,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

// readInitialPassword pulls an optional { password } from the JSON body, if any.
// A missing/invalid body just means no password (the common case).
async function readInitialPassword(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.json()) as { password?: unknown };
    return typeof body.password === "string" && body.password !== "" ? body.password : undefined;
  } catch {
    return undefined;
  }
}

async function sessionPage(env: Env, id: string, html: string): Promise<Response> {
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  if (!(await stub.exists())) {
    return secured("session not found", CONTENT_TYPE.text, 404);
  }
  return secured(html, CONTENT_TYPE.html);
}

async function vaultPage(env: Env, id: string): Promise<Response> {
  const stub = env.VAULT.get(env.VAULT.idFromName(id));
  if (!(await stub.exists())) {
    return secured("vault not found", CONTENT_TYPE.text, 404);
  }
  return secured(vaultHtml, CONTENT_TYPE.html);
}

async function vaultJson(env: Env, id: string, request?: Request): Promise<Response> {
  const stub = env.VAULT.get(env.VAULT.idFromName(id));
  const info = await stub.info(bearerToken(request));
  if (!info) {
    return secured("vault not found", CONTENT_TYPE.text, 404);
  }
  return secured(JSON.stringify({ ...info, id }), CONTENT_TYPE.json);
}

async function vaultFile(
  request: Request,
  env: Env,
  id: string,
  name: "events.jsonl" | "transcript.txt",
  contentType: string,
): Promise<Response> {
  const stub = env.VAULT.get(env.VAULT.idFromName(id));
  const text = await stub.readFile(name, bearerToken(request));
  if (text === null) {
    return secured("vault not found", CONTENT_TYPE.text, 404);
  }
  return secured(text, contentType);
}

async function revokeVault(request: Request, env: Env, id: string): Promise<Response> {
  const stub = env.VAULT.get(env.VAULT.idFromName(id));
  if (!(await stub.revoke(bearerToken(request)))) {
    return secured("vault not found", CONTENT_TYPE.text, 404);
  }
  return secured(JSON.stringify({ deleted: true }), CONTENT_TYPE.json);
}

async function websocket(env: Env, request: Request, id: string): Promise<Response> {
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  if (!(await stub.exists())) {
    return new Response("session not found", { status: 404 });
  }
  return stub.fetch(request);
}

function bearerToken(request: Request | undefined): string {
  const auth = request?.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : "";
}
