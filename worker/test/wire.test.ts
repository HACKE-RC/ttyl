import { describe, expect, it } from "vitest";
import { decode, encode, Kind, ShortFrameError } from "../src/core/wire";
import { encodeBase32NoPad, newSessionID } from "../src/core/base32";

const te = new TextEncoder();

describe("wire encode", () => {
  it("encodes Output as [kind, ...data]", () => {
    const data = te.encode("hello");
    expect([...encode({ kind: Kind.Output, data })]).toEqual([0, ...data]);
  });

  it("encodes Input as [kind, ...data]", () => {
    const data = te.encode("ls\n");
    expect([...encode({ kind: Kind.Input, data })]).toEqual([1, ...data]);
  });

  it("encodes Resize as kind + two big-endian uint16s", () => {
    // 120 = 0x0078, 40 = 0x0028
    expect([...encode({ kind: Kind.Resize, cols: 120, rows: 40 })]).toEqual([
      2, 0x00, 0x78, 0x00, 0x28,
    ]);
  });

  it("encodes an empty Output frame as a single kind byte", () => {
    expect([...encode({ kind: Kind.Output, data: new Uint8Array(0) })]).toEqual([0]);
  });
});

describe("wire decode", () => {
  it("round-trips Output", () => {
    const data = te.encode("some output bytes \x1b[31m");
    const f = decode(encode({ kind: Kind.Output, data }));
    expect(f.kind).toBe(Kind.Output);
    expect([...f.data!]).toEqual([...data]);
  });

  it("round-trips Resize", () => {
    const f = decode(encode({ kind: Kind.Resize, cols: 200, rows: 50 }));
    expect(f.kind).toBe(Kind.Resize);
    expect(f.cols).toBe(200);
    expect(f.rows).toBe(50);
  });

  it("throws on empty buffer", () => {
    expect(() => decode(new Uint8Array(0))).toThrow(ShortFrameError);
  });

  it("throws on a short Resize payload", () => {
    expect(() => decode(new Uint8Array([2, 0, 1]))).toThrow(ShortFrameError);
  });

  it("throws on an unknown kind", () => {
    expect(() => decode(new Uint8Array([9, 1, 2, 3]))).toThrow();
  });

  it("does not alias the source buffer", () => {
    const src = encode({ kind: Kind.Output, data: te.encode("abc") });
    const f = decode(src);
    src[1] = 0;
    expect(f.data![0]).toBe("a".charCodeAt(0));
  });
});

describe("base32 session IDs", () => {
  it("matches RFC 4648 no-pad vectors (parity with Go StdEncoding)", () => {
    expect(encodeBase32NoPad(te.encode("foobar"))).toBe("MZXW6YTBOI");
    expect(encodeBase32NoPad(new Uint8Array(15))).toBe("A".repeat(24));
    expect(encodeBase32NoPad(new Uint8Array(15).fill(0xff))).toBe("7".repeat(24));
  });

  it("mints 24-character tokens from the alphabet", () => {
    const id = newSessionID();
    expect(id).toHaveLength(24);
    expect(id).toMatch(/^[A-Z2-7]{24}$/);
  });

  it("mints unique IDs", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newSessionID()));
    expect(ids.size).toBe(1000);
  });
});
