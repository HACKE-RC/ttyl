// Cloudflare Worker adapter for the astream relay. The stateless Worker routes
// requests; one Durable Object per session id holds a core Relay in memory and
// bridges real WebSockets to it. Sockets use the classic accept() API so the
// Durable Object stays resident (and its Relay state intact) while a session is
// live; lifecycle state is persisted so the session survives the brief gap
// between creation and the first connection, and so its 404-after-end and TTL
// semantics hold across evictions.
import { DurableObject } from "cloudflare:workers";
import { Relay, type Conn, type Role } from "../core/relay";
import { newSessionID } from "../core/base32";
import {
  CONTENT_TYPE,
  parseTtlParam,
  resolveTtlSeconds,
  securityHeaders,
  VIEWER_PATH,
  WS_PATH,
} from "../core/http";
import indexHtml from "../../web/index.html";
import viewerJs from "../../web/viewer.client.txt";
import xtermJs from "../../web/vendor/xterm.lib.txt";
import xtermCss from "../../web/vendor/xterm.style.txt";

const KEY_CREATED = "created";
const KEY_ENDED = "ended";
const KEY_CONTROL = "key";
const KEY_NEVER = "never";

// A session that never receives a broadcaster within this window is reaped, so
// an abandoned "never expire" session does not leave its record behind forever.
const CONNECT_GRACE_MS = 2 * 60 * 1000;

export interface Env {
  SESSION: DurableObjectNamespace<SessionRelay>;
  SESSION_LIMITER?: RateLimit;
  SESSION_TTL_SECONDS?: string;
}

export class SessionRelay extends DurableObject<Env> {
  private relay: Relay | null = null;
  private created = false;
  private ended = false;
  private never = false;
  private controlKey = "";
  private loaded = false;

  // create marks the session live and arms its expiry. ttlOverride (seconds)
  // comes from the client's --lifetime: 0 means never expire (no alarm), a
  // positive value is clamped, and undefined falls back to the server default.
  async create(controlKey: string, ttlOverride?: number): Promise<void> {
    await this.ensureLoaded();
    this.created = true;
    this.controlKey = controlKey;
    await this.ctx.storage.put(KEY_CREATED, true);
    await this.ctx.storage.put(KEY_CONTROL, controlKey);
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

    const role: Role = new URL(request.url).pathname.endsWith("/broadcast")
      ? "broadcaster"
      : "viewer";

    if (!this.relay) {
      this.relay = new Relay(this.controlKey, () => void this.handleEnd());
    }
    const relay = this.relay;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const conn: Conn = {
      role,
      authed: false,
      writer: false,
      send: (d) => {
        try {
          server.send(d);
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
    // For a "never expire" session, the alarm is only the connect grace: if a
    // broadcaster is live, leave the session running (and set no new alarm, so
    // it truly never expires); otherwise it was abandoned, so reap it.
    if (this.never && this.relay?.hasBroadcaster) {
      return;
    }
    if (this.relay) {
      this.relay.end();
    } else {
      await this.handleEnd();
    }
  }

  private async handleEnd(): Promise<void> {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.relay = null;
    this.controlKey = "";
    await this.ctx.storage.put(KEY_ENDED, true);
    await this.ctx.storage.delete([KEY_CONTROL, KEY_NEVER]);
    await this.ctx.storage.deleteAlarm();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const stored = await this.ctx.storage.get<boolean | string>([
      KEY_CREATED,
      KEY_ENDED,
      KEY_CONTROL,
      KEY_NEVER,
    ]);
    this.created = stored.get(KEY_CREATED) === true;
    this.ended = stored.get(KEY_ENDED) === true;
    this.never = stored.get(KEY_NEVER) === true;
    const key = stored.get(KEY_CONTROL);
    if (typeof key === "string") {
      this.controlKey = key;
    }
    this.loaded = true;
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

    if (request.method === "GET") {
      if (path === "/") {
        return secured(
          "astream relay server. Start a stream with: astream stream\n",
          CONTENT_TYPE.text,
        );
      }
      if (path === "/static/viewer.js") {
        return secured(viewerJs, CONTENT_TYPE.js);
      }
      if (path === "/static/xterm.js") {
        return secured(xtermJs, CONTENT_TYPE.js);
      }
      if (path === "/static/xterm.css") {
        return secured(xtermCss, CONTENT_TYPE.css);
      }

      const viewerMatch = path.match(VIEWER_PATH);
      if (viewerMatch) {
        return viewerPage(env, viewerMatch[1]);
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
  const ttl = parseTtlParam(new URL(request.url).searchParams.get("ttl"));
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  await stub.create(key, ttl);

  return new Response(JSON.stringify({ id, key }), {
    headers: {
      "Content-Type": CONTENT_TYPE.json,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

async function viewerPage(env: Env, id: string): Promise<Response> {
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  if (!(await stub.exists())) {
    return secured("session not found", CONTENT_TYPE.text, 404);
  }
  return secured(indexHtml, CONTENT_TYPE.html);
}

async function websocket(env: Env, request: Request, id: string): Promise<Response> {
  const stub = env.SESSION.get(env.SESSION.idFromName(id));
  if (!(await stub.exists())) {
    return new Response("session not found", { status: 404 });
  }
  return stub.fetch(request);
}
