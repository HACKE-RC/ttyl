// Authentication primitives for the relay: how the Auth handshake payload is
// framed, a constant-time string compare for capability keys, and password
// hashing/verification. This is the one place that knows how a presented
// credential becomes a yes/no, so neither the core brain nor the adapters have
// to grow crypto details.
//
// The Auth frame's bytes (wire.ts Kind.Auth) carry a tiny JSON object
// { k?, p? }: the control key and an optional session password. Keeping it JSON
// (instead of the old raw key string) leaves room for the password without
// touching the binary Output/Input/Resize layouts.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// AuthPayload is what a socket presents in its first frame. Both fields are
// optional: a view-only viewer sends neither, a read-write viewer sends k, and
// a password-gated viewer also sends p.
export interface AuthPayload {
  k?: string;
  p?: string;
}

// parseAuthPayload decodes the Auth frame bytes. New clients send JSON; a
// non-JSON payload is treated as a bare control key (k) so any older client
// that sent the raw key string still authenticates.
export function parseAuthPayload(bytes: Uint8Array): AuthPayload {
  const text = decoder.decode(bytes);
  if (text === "") {
    return {};
  }
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj && typeof obj === "object") {
      const rec = obj as Record<string, unknown>;
      const out: AuthPayload = {};
      if (typeof rec.k === "string") {
        out.k = rec.k;
      }
      if (typeof rec.p === "string") {
        out.p = rec.p;
      }
      return out;
    }
  } catch {
    // not JSON: fall through to the legacy raw-key interpretation
  }
  return { k: text };
}

// encodeAuthPayload frames an AuthPayload as JSON bytes, omitting empty fields
// so a view-only viewer sends "{}" rather than leaking empty keys.
export function encodeAuthPayload(payload: AuthPayload): Uint8Array {
  const out: AuthPayload = {};
  if (payload.k) {
    out.k = payload.k;
  }
  if (payload.p) {
    out.p = payload.p;
  }
  return encoder.encode(JSON.stringify(out));
}

// timingSafeEqual compares two strings without leaking, via early return, how
// many leading characters matched. Capability keys are fixed length, so the
// length branch is not a meaningful signal; it just avoids indexing past the
// end.
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// StoredPassword is the hash record kept per session (never the plaintext). It
// is small and JSON-serializable so the Worker can persist it to Durable Object
// storage.
export interface StoredPassword {
  salt: string; // hex
  hash: string; // hex, PBKDF2-SHA256 derived bits
  iter: number;
}

// PBKDF2 work factor. High enough to slow brute force on the short passwords a
// human types, low enough that a viewer's join handshake stays well under a
// frame's worth of latency in both Node and a Worker.
const PBKDF2_ITER = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

async function deriveBits(plain: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(plain),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    keyMaterial,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

// hashPassword derives a salted PBKDF2-SHA256 hash of plain. The returned record
// is what gets stored; the plaintext is never retained.
export async function hashPassword(plain: string): Promise<StoredPassword> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const hash = await deriveBits(plain, salt, PBKDF2_ITER);
  return { salt: toHex(salt), hash: toHex(hash), iter: PBKDF2_ITER };
}

// verifyPassword recomputes the hash of plain with the stored salt/iterations
// and compares it to the stored hash in constant time.
export async function verifyPassword(plain: string, stored: StoredPassword): Promise<boolean> {
  const salt = fromHex(stored.salt);
  const hash = await deriveBits(plain, salt, stored.iter);
  return timingSafeEqual(toHex(hash), stored.hash);
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
