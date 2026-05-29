import { describe, expect, it } from "vitest";
import {
  encodeAuthPayload,
  hashPassword,
  parseAuthPayload,
  timingSafeEqual,
  verifyPassword,
} from "../src/core/auth";

const te = new TextEncoder();

describe("auth payload framing", () => {
  it("round-trips a JSON payload", () => {
    const bytes = encodeAuthPayload({ k: "control", p: "secret" });
    expect(parseAuthPayload(bytes)).toEqual({ k: "control", p: "secret" });
  });

  it("omits empty fields when encoding", () => {
    expect(parseAuthPayload(encodeAuthPayload({}))).toEqual({});
    expect(parseAuthPayload(encodeAuthPayload({ k: "" }))).toEqual({});
    expect(parseAuthPayload(encodeAuthPayload({ k: "x", p: "" }))).toEqual({ k: "x" });
  });

  it("treats an empty frame as view-only (no fields)", () => {
    expect(parseAuthPayload(new Uint8Array(0))).toEqual({});
  });

  it("falls back to a bare control key for a non-JSON (legacy) payload", () => {
    expect(parseAuthPayload(te.encode("RAWCONTROLKEY"))).toEqual({ k: "RAWCONTROLKEY" });
  });

  it("ignores non-string fields", () => {
    expect(parseAuthPayload(te.encode(JSON.stringify({ k: 1, p: true })))).toEqual({});
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("password hashing", () => {
  it("verifies the correct password and rejects the wrong one", async () => {
    const stored = await hashPassword("hunter2");
    expect(await verifyPassword("hunter2", stored)).toBe(true);
    expect(await verifyPassword("hunter3", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("uses a random salt so equal passwords hash differently", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // ...but both still verify.
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });
});
