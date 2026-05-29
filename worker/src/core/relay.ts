// Relay is the pure, transport-agnostic core of astream: it connects one PTY
// broadcaster to many web viewers and contains all of the routing, scrollback,
// authentication, and access-control logic. It is the shared brain used by both
// deployment adapters (the Cloudflare Worker Durable Object and the Node
// server); neither WebSockets nor storage nor PTYs appear here.
//
// A Relay speaks only in terms of Conn (an abstract connection that can send
// bytes and close) and decoded wire frames. Each adapter wraps its real sockets
// as Conn values and forwards messages/closes into the Relay.
import { decode, encode, Kind } from "./wire";

export type Role = "broadcaster" | "viewer";

// Conn is a single connection as seen by the core. The adapter owns the real
// socket; the core only sends, closes, and tracks the auth/writer bits it sets
// during the handshake.
export interface Conn {
  readonly role: Role;
  authed: boolean;
  writer: boolean;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

// scrollbackBytes mirrors the Go constant: a few screens of recent output are
// retained and replayed so late joiners do not start from a blank terminal.
const SCROLLBACK_BYTES = 256 * 1024;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// timingSafeEqual compares two strings without leaking, via early return, how
// many leading characters matched. Control keys are fixed length, so the length
// branch is not a meaningful signal; it just avoids indexing past the end.
function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

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
  private scrollback = new Scrollback(SCROLLBACK_BYTES);
  private lastResize: Uint8Array | null = null;
  ended = false;

  // controlKey is the read-write capability. onEnd runs exactly once when the
  // session ends, letting the adapter tear down its registry/storage.
  constructor(
    private readonly controlKey: string,
    private readonly onEnd: () => void,
  ) {}

  // hasBroadcaster reports whether an authenticated broadcaster is connected.
  // Adapters use it to reap sessions that were created but never streamed to.
  get hasBroadcaster(): boolean {
    return this.broadcaster !== null;
  }

  // message routes one binary frame from conn. The first frame on any conn must
  // be an Auth handshake; only after a successful handshake are data frames
  // relayed.
  message(conn: Conn, data: Uint8Array): void {
    if (this.ended) {
      return;
    }
    let frame;
    try {
      frame = decode(data);
    } catch {
      return; // malformed frame: drop it, like the Go reader
    }

    if (!conn.authed) {
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

  // close removes a connection. The session ends when the authed broadcaster
  // leaves; a viewer leaving does not affect the session.
  close(conn: Conn): void {
    this.viewers.delete(conn);
    if (conn === this.broadcaster) {
      this.broadcaster = null;
      if (conn.authed) {
        this.end();
      }
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
    this.broadcaster = null;
    this.viewers.clear();
    this.scrollback.clear();
    this.lastResize = null;
    this.onEnd();
  }

  private handshake(conn: Conn, frame: ReturnType<typeof decode>): void {
    if (frame.kind !== Kind.Auth) {
      conn.close(1008, "auth required");
      return;
    }
    const presented = decoder.decode(frame.data ?? new Uint8Array(0));
    const keyOk = this.controlKey !== "" && timingSafeEqual(presented, this.controlKey);

    if (conn.role === "broadcaster") {
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
      this.broadcaster = conn;
      return;
    }

    // Viewer: a valid key grants typing; anything else is view-only.
    conn.authed = true;
    conn.writer = keyOk;
    this.viewers.add(conn);
    this.replayTo(conn);
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
