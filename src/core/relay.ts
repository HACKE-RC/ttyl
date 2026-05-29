// Relay is the pure, transport-agnostic core of ttyl: it connects one PTY
// broadcaster to many web viewers and contains all of the routing, scrollback,
// authentication, and access-control logic. It is the shared brain used by both
// deployment adapters (the Cloudflare Worker Durable Object and the Node
// server); neither WebSockets nor storage nor PTYs appear here.
//
// A Relay speaks only in terms of Conn (an abstract connection that can send
// bytes/text and close) and decoded wire frames. Each adapter wraps its real
// sockets as Conn values and forwards messages/closes into the Relay.
//
// There are two planes. The data plane (broadcaster + viewers) uses the binary
// wire protocol. The control plane (owner-only admins) uses JSON text and is the
// optional management layer: a live roster, kick, lock, and a session password.
// With no password and no lock, a session behaves exactly as it did before the
// management layer existed.
import { decode, encode, Kind } from "./wire";
import {
  hashPassword,
  parseAuthPayload,
  timingSafeEqual,
  verifyPassword,
  type AuthPayload,
  type StoredPassword,
} from "./auth";
import {
  parseAdminMessage,
  serializeServerMessage,
  type RosterEntry,
  type Roster,
} from "./admin";

export type Role = "broadcaster" | "viewer" | "admin";

// ConnMeta is best-effort connection provenance the adapter fills in from the
// request. It is only ever shown on the owner's dashboard.
export interface ConnMeta {
  ip?: string;
  ua?: string;
}

// Conn is a single connection as seen by the core. The adapter owns the real
// socket; the core only sends, closes, and tracks the auth/writer bits it sets
// during the handshake. id is assigned by the core once the conn authenticates.
export interface Conn {
  readonly role: Role;
  authed: boolean;
  writer: boolean;
  id: string;
  meta?: ConnMeta;
  send(data: Uint8Array): void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
}

// PersistState is the management state an adapter may need to durably store so
// it survives across the gaps that the Worker's Durable Object has between
// in-memory lifetimes. The Node adapter keeps everything in memory and ignores
// it.
export interface PersistState {
  password: StoredPassword | null;
  locked: boolean;
}

export interface RelayOptions {
  controlKey: string;
  adminKey: string;
  password?: StoredPassword | null;
  locked?: boolean;
  onEnd: () => void;
  onPersist?: (state: PersistState) => void;
}

// Application-defined WebSocket close codes (4000-4999) the viewer reacts to.
export const CLOSE_KICKED = 4001;
export const CLOSE_LOCKED = 4002;
export const CLOSE_PASSWORD_REQUIRED = 4003;
export const CLOSE_PASSWORD_INCORRECT = 4004;
export const CLOSE_TOO_MANY_ATTEMPTS = 4005;

// scrollbackBytes mirrors the Go constant: a few screens of recent output are
// retained and replayed so late joiners do not start from a blank terminal.
const SCROLLBACK_BYTES = 256 * 1024;

// Failed-password throttle: after this many wrong passwords within the window,
// further attempts are refused for the rest of the window. Coarse brute-force
// protection on top of the unguessable session id.
const PW_MAX_FAILURES = 5;
const PW_WINDOW_MS = 60_000;
const MAX_AUTH_PAYLOAD_BYTES = 2048;
const MAX_PASSWORD_BYTES = 512;

// Scrollback is a bounded byte window of recent output, kept as a list of chunks
// so appends are amortized O(1) instead of reallocating the whole buffer on
// every frame. The oldest bytes are trimmed once the cap is exceeded; replaying
// the window to a fresh xterm reconstructs the visible screen.
class Scrollback {
  private chunks: Uint8Array[] = [];
  private total = 0;

  constructor(private readonly max: number) {}

  get length(): number {
    return this.total;
  }

  // append retains data (already an owned copy from wire.decode) and trims the
  // oldest bytes past the cap, slicing the head chunk when it straddles the cap.
  append(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }
    this.chunks.push(data);
    this.total += data.length;
    while (this.total > this.max && this.chunks.length > 0) {
      const head = this.chunks[0];
      const over = this.total - this.max;
      if (head.length <= over) {
        this.chunks.shift();
        this.total -= head.length;
      } else {
        this.chunks[0] = head.subarray(over);
        this.total -= over;
      }
    }
  }

  // snapshot concatenates the window into one buffer (only on viewer join, not
  // per frame).
  snapshot(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  clear(): void {
    this.chunks = [];
    this.total = 0;
  }
}

export class Relay {
  private broadcaster: Conn | null = null;
  private viewers = new Set<Conn>();
  private admins = new Set<Conn>();
  private scrollback = new Scrollback(SCROLLBACK_BYTES);
  private lastResize: Uint8Array | null = null;
  ended = false;

  private readonly controlKey: string;
  private readonly adminKey: string;
  private password: StoredPassword | null;
  private locked: boolean;
  private readonly onEnd: () => void;
  private readonly onPersist?: (state: PersistState) => void;

  // Per-conn bookkeeping kept off Conn so adapters stay minimal: connection ids,
  // join times, and which conns are mid-async-password-check.
  private seq = 0;
  private joinedAt = new WeakMap<Conn, number>();
  private verifyingConns = new Set<Conn>();
  // Failed password attempts, bucketed per client IP so one attacker cannot lock
  // out everyone else by burning the session's whole quota.
  private pwFailures = new Map<string, number[]>();
  private pwPending = new Map<string, number>();
  // Monotonic generation stamp for password mutations, so a slow async set that
  // is superseded by a later set/clear does not clobber the newer state.
  private pwGen = 0;
  // Any change to lock/password policy bumps this. In-flight password checks
  // must see the same generation before admitting a viewer.
  private policyGen = 0;

  constructor(options: RelayOptions) {
    this.controlKey = options.controlKey;
    this.adminKey = options.adminKey;
    this.password = options.password ?? null;
    this.locked = options.locked ?? false;
    this.onEnd = options.onEnd;
    this.onPersist = options.onPersist;
  }

  // hasBroadcaster reports whether an authenticated broadcaster is connected.
  // Adapters use it to reap sessions that were created but never streamed to.
  get hasBroadcaster(): boolean {
    return this.broadcaster !== null && this.broadcaster.authed;
  }

  // message routes one binary frame from a data-plane conn (broadcaster or
  // viewer). The first frame on any such conn must be an Auth handshake; only
  // after a successful handshake are data frames relayed.
  message(conn: Conn, data: Uint8Array): void {
    if (this.ended || conn.role === "admin") {
      return;
    }
    let frame;
    try {
      frame = decode(data);
    } catch {
      return; // malformed frame: drop it, like the Go reader
    }

    if (!conn.authed) {
      // While a viewer's password is being verified asynchronously, ignore any
      // further frames it sends rather than starting a second handshake.
      if (this.verifyingConns.has(conn)) {
        return;
      }
      this.handshake(conn, frame);
      return;
    }

    if (conn.role === "broadcaster") {
      switch (frame.kind) {
        case Kind.Output:
          this.scrollback.append(frame.data ?? new Uint8Array(0));
          this.fanOutToViewers(data);
          return;
        case Kind.Resize:
          this.lastResize = data.slice();
          this.fanOutToViewers(data);
          return;
        case Kind.Input:
        case Kind.Auth:
          return; // a broadcaster does not send these once authed
      }
    } else if (frame.kind === Kind.Input && conn.writer && this.broadcaster) {
      // Only a viewer that proved the control key may type. View-only viewers
      // are silently ignored, which is what makes a view-only link read-only.
      this.broadcaster.send(data);
    }
  }

  // controlMessage routes one JSON text message from an admin (control plane).
  // The first message must be a hello carrying the admin key.
  controlMessage(conn: Conn, text: string): void {
    if (this.ended || conn.role !== "admin") {
      return;
    }
    const msg = parseAdminMessage(text);
    if (!msg) {
      return;
    }
    if (!conn.authed) {
      if (msg.type === "hello") {
        this.adminHandshake(conn, msg.key);
      } else {
        conn.close(1008, "auth required");
      }
      return;
    }
    switch (msg.type) {
      case "hello":
        return; // already authed; ignore a repeat
      case "kick":
        this.kick(msg.id);
        return;
      case "lock":
        this.setLocked(true);
        return;
      case "unlock":
        this.setLocked(false);
        return;
      case "password":
        if ("clear" in msg) {
          this.clearPassword();
        } else {
          void this.setPassword(msg.value);
        }
        return;
      case "end":
        // Owner-initiated shutdown: close everyone (broadcaster included) and
        // fire onEnd, exactly as a broadcaster disconnect would.
        this.end();
        return;
      default:
        msg satisfies never; // exhaustiveness: every admin message is handled
        return;
    }
  }

  // close removes a connection. The session ends when the authed broadcaster
  // leaves; a viewer or admin leaving does not affect the session.
  close(conn: Conn): void {
    this.viewers.delete(conn);
    this.admins.delete(conn);
    this.verifyingConns.delete(conn);
    this.joinedAt.delete(conn);
    if (conn === this.broadcaster) {
      this.broadcaster = null;
      if (conn.authed) {
        this.end();
        return;
      }
    }
    if (!this.ended) {
      this.notifyAdmins();
    }
  }

  // end disconnects everyone and fires onEnd exactly once.
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.broadcaster?.close(1000, "session ended");
    for (const v of this.viewers) {
      v.close(1000, "session ended");
    }
    for (const a of this.admins) {
      a.close(1000, "session ended");
    }
    this.broadcaster = null;
    this.viewers.clear();
    this.admins.clear();
    this.verifyingConns.clear();
    this.scrollback.clear();
    this.lastResize = null;
    this.onEnd();
  }

  private handshake(conn: Conn, frame: ReturnType<typeof decode>): void {
    if (frame.kind !== Kind.Auth) {
      conn.close(1008, "auth required");
      return;
    }
    if ((frame.data?.length ?? 0) > MAX_AUTH_PAYLOAD_BYTES) {
      conn.close(1008, "auth payload too large");
      return;
    }
    const payload = parseAuthPayload(frame.data ?? new Uint8Array(0));
    const keyOk = this.controlKey !== "" && timingSafeEqual(payload.k ?? "", this.controlKey);

    if (conn.role === "broadcaster") {
      // The broadcaster authenticates with the control key only; the session
      // password never applies to it.
      if (!keyOk) {
        conn.close(1008, "forbidden");
        return;
      }
      if (this.broadcaster && this.broadcaster.authed) {
        conn.close(1008, "broadcaster already connected");
        return;
      }
      conn.authed = true;
      conn.writer = true;
      conn.id = this.nextId();
      this.broadcaster = conn;
      this.joinedAt.set(conn, Date.now());
      this.notifyAdmins();
      return;
    }

    // Viewer. A lock refuses new joins outright; a password gates everyone
    // (including read-write link holders) before they are admitted.
    if (this.locked) {
      conn.close(CLOSE_LOCKED, "locked");
      return;
    }
    if (this.password) {
      this.verifyViewerPassword(conn, payload, keyOk);
      return;
    }
    this.admitViewer(conn, keyOk);
  }

  private verifyViewerPassword(conn: Conn, payload: AuthPayload, keyOk: boolean): void {
    const ip = conn.meta?.ip ?? "anon";
    if (this.recentPwFailures(ip).length + this.pendingPwAttempts(ip) >= PW_MAX_FAILURES) {
      conn.close(CLOSE_TOO_MANY_ATTEMPTS, "too many attempts");
      return;
    }
    if (payload.p === undefined) {
      conn.close(CLOSE_PASSWORD_REQUIRED, "password required");
      return;
    }
    if (new TextEncoder().encode(payload.p).length > MAX_PASSWORD_BYTES) {
      this.recordPwFailure(ip);
      conn.close(CLOSE_PASSWORD_INCORRECT, "password incorrect");
      return;
    }
    const stored = this.password;
    if (!stored) {
      // Password was cleared between the frame arriving and now; just admit.
      this.admitViewer(conn, keyOk);
      return;
    }
    const policyGen = this.policyGen;
    this.setPendingPwAttempts(ip, this.pendingPwAttempts(ip) + 1);
    this.verifyingConns.add(conn);
    void verifyPassword(payload.p, stored).then(
      (ok) => {
        this.setPendingPwAttempts(ip, this.pendingPwAttempts(ip) - 1);
        // If the conn closed (or the session ended) during the async check, it
        // was already removed from verifyingConns; do nothing.
        if (!this.verifyingConns.has(conn)) {
          return;
        }
        this.verifyingConns.delete(conn);
        if (this.ended) {
          return;
        }
        if (this.locked || policyGen !== this.policyGen || this.password !== stored) {
          conn.close(this.locked ? CLOSE_LOCKED : CLOSE_PASSWORD_REQUIRED, "auth policy changed");
          return;
        }
        if (!ok) {
          this.recordPwFailure(ip);
          conn.close(CLOSE_PASSWORD_INCORRECT, "password incorrect");
          return;
        }
        this.admitViewer(conn, keyOk);
      },
      () => {
        this.setPendingPwAttempts(ip, this.pendingPwAttempts(ip) - 1);
        this.verifyingConns.delete(conn);
        conn.close(1011, "auth error");
      },
    );
  }

  private admitViewer(conn: Conn, keyOk: boolean): void {
    if (this.ended) {
      return;
    }
    conn.authed = true;
    conn.writer = keyOk;
    conn.id = this.nextId();
    this.joinedAt.set(conn, Date.now());
    this.viewers.add(conn);
    this.replayTo(conn);
    this.notifyAdmins();
  }

  private adminHandshake(conn: Conn, key: string): void {
    if (this.adminKey === "" || !timingSafeEqual(key, this.adminKey)) {
      conn.close(1008, "forbidden");
      return;
    }
    conn.authed = true;
    conn.id = this.nextId();
    this.admins.add(conn);
    conn.sendText(serializeServerMessage(this.roster()));
  }

  private kick(id: string): void {
    // Only viewers are kickable; the broadcaster ends the session by leaving on
    // its own, and admins manage themselves.
    for (const v of this.viewers) {
      if (v.id === id) {
        v.close(CLOSE_KICKED, "kicked");
        return;
      }
    }
  }

  private setLocked(value: boolean): void {
    if (this.locked !== value) {
      this.locked = value;
      this.policyGen += 1;
      this.persist();
    }
    this.notifyAdmins();
  }

  private async setPassword(value: string): Promise<void> {
    if (value === "") {
      this.clearPassword();
      return;
    }
    if (new TextEncoder().encode(value).length > MAX_PASSWORD_BYTES) {
      return;
    }
    // Stamp this mutation; if a newer set/clear lands while we hash, discard our
    // result so the owner's most recent intent wins.
    const gen = ++this.pwGen;
    const hashed = await hashPassword(value);
    if (this.ended || gen !== this.pwGen) {
      return;
    }
    this.password = hashed;
    this.policyGen += 1;
    this.persist();
    this.notifyAdmins();
  }

  private clearPassword(): void {
    this.pwGen += 1;
    this.password = null;
    this.policyGen += 1;
    this.persist();
    this.notifyAdmins();
  }

  private persist(): void {
    this.onPersist?.({ password: this.password, locked: this.locked });
  }

  // recentPwFailures returns (and compacts) the in-window failures for one IP.
  private recentPwFailures(ip: string): number[] {
    const cutoff = Date.now() - PW_WINDOW_MS;
    const recent = (this.pwFailures.get(ip) ?? []).filter((t) => t > cutoff);
    if (recent.length > 0) {
      this.pwFailures.set(ip, recent);
    } else {
      this.pwFailures.delete(ip);
    }
    return recent;
  }

  private recordPwFailure(ip: string): void {
    const recent = this.recentPwFailures(ip);
    recent.push(Date.now());
    this.pwFailures.set(ip, recent);
  }

  private pendingPwAttempts(ip: string): number {
    return this.pwPending.get(ip) ?? 0;
  }

  private setPendingPwAttempts(ip: string, count: number): void {
    if (count > 0) {
      this.pwPending.set(ip, count);
    } else {
      this.pwPending.delete(ip);
    }
  }

  private nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  private roster(): Roster {
    const clients: RosterEntry[] = [];
    if (this.broadcaster && this.broadcaster.authed) {
      clients.push(this.entry(this.broadcaster));
    }
    for (const v of this.viewers) {
      clients.push(this.entry(v));
    }
    return {
      type: "roster",
      clients,
      locked: this.locked,
      hasPassword: this.password !== null,
      hasBroadcaster: this.hasBroadcaster,
    };
  }

  private entry(conn: Conn): RosterEntry {
    return {
      id: conn.id,
      role: conn.role === "broadcaster" ? "broadcaster" : "viewer",
      writer: conn.writer,
      joinedAt: this.joinedAt.get(conn) ?? 0,
      ip: conn.meta?.ip,
      ua: conn.meta?.ua,
    };
  }

  private notifyAdmins(): void {
    if (this.admins.size === 0) {
      return;
    }
    const msg = serializeServerMessage(this.roster());
    for (const a of this.admins) {
      a.sendText(msg);
    }
  }

  // replayTo brings a freshly joined viewer up to the current state: the last
  // size first, then the buffered output.
  private replayTo(viewer: Conn): void {
    if (this.lastResize) {
      viewer.send(this.lastResize);
    }
    if (this.scrollback.length > 0) {
      viewer.send(encode({ kind: Kind.Output, data: this.scrollback.snapshot() }));
    }
  }

  private fanOutToViewers(data: Uint8Array): void {
    for (const v of this.viewers) {
      v.send(data);
    }
  }
}
