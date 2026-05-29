// Port of internal/wire: the single source of truth for the ttyl protocol.
//
// Each WebSocket binary message is one frame: a single Kind byte followed by
// the payload. Output/Input carry raw bytes; Resize carries two big-endian
// uint16s (cols, rows). The byte layout must stay identical to the Go encoder
// so the existing Go client and browser viewer interoperate unchanged.

export enum Kind {
  Output = 0,
  Input = 1,
  Resize = 2,
  // Auth is the first frame a socket sends: its payload is the control key
  // (UTF-8), or empty for a view-only viewer. It never appears in a URL, so the
  // key stays out of request lines, logs, and browser history.
  Auth = 3,
}

export interface Frame {
  kind: Kind;
  data?: Uint8Array;
  cols?: number;
  rows?: number;
}

// Fixed payload size of a Resize frame: two uint16s.
const RESIZE_PAYLOAD_LEN = 4;

export class ShortFrameError extends Error {
  constructor() {
    super("wire: short frame");
    this.name = "ShortFrameError";
  }
}

export function encode(frame: Frame): Uint8Array {
  switch (frame.kind) {
    case Kind.Output:
    case Kind.Input:
    case Kind.Auth: {
      const data = frame.data ?? new Uint8Array(0);
      const buf = new Uint8Array(1 + data.length);
      buf[0] = frame.kind;
      buf.set(data, 1);
      return buf;
    }
    case Kind.Resize: {
      const buf = new Uint8Array(1 + RESIZE_PAYLOAD_LEN);
      buf[0] = frame.kind;
      const view = new DataView(buf.buffer);
      view.setUint16(1, frame.cols ?? 0, false);
      view.setUint16(3, frame.rows ?? 0, false);
      return buf;
    }
    default:
      throw new Error(`wire: encode unknown kind ${frame.kind}`);
  }
}

export function decode(buf: Uint8Array): Frame {
  if (buf.length < 1) {
    throw new ShortFrameError();
  }
  const kind = buf[0] as Kind;
  const payload = buf.subarray(1);
  switch (kind) {
    case Kind.Output:
    case Kind.Input:
    case Kind.Auth: {
      // Copy the payload so callers may retain it independent of the source
      // buffer, matching the Go decoder.
      return { kind, data: payload.slice() };
    }
    case Kind.Resize: {
      if (payload.length < RESIZE_PAYLOAD_LEN) {
        throw new ShortFrameError();
      }
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      return { kind, cols: view.getUint16(0, false), rows: view.getUint16(2, false) };
    }
    default:
      throw new Error(`wire: unknown kind ${kind}`);
  }
}
