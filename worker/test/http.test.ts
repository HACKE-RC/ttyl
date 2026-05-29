import { describe, expect, it } from "vitest";
import {
  clampTtl,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
  NEVER_TTL,
  parseTtlParam,
  resolveTtlSeconds,
} from "../src/core/http";

describe("ttl policy (shared by both adapters)", () => {
  it("clamps positive values into [MIN, MAX]", () => {
    expect(clampTtl(1)).toBe(MIN_TTL_SECONDS);
    expect(clampTtl(MAX_TTL_SECONDS + 1)).toBe(MAX_TTL_SECONDS);
    expect(clampTtl(3600)).toBe(3600);
  });

  it("treats non-positive as NEVER", () => {
    expect(clampTtl(0)).toBe(NEVER_TTL);
    expect(clampTtl(-5)).toBe(NEVER_TTL);
  });

  it("parseTtlParam: null/garbage/negative => undefined (use default)", () => {
    expect(parseTtlParam(null)).toBeUndefined();
    expect(parseTtlParam("abc")).toBeUndefined();
    expect(parseTtlParam("-1")).toBeUndefined();
  });

  it("parseTtlParam: 0 => never, positive => clamped", () => {
    expect(parseTtlParam("0")).toBe(NEVER_TTL);
    expect(parseTtlParam("1")).toBe(MIN_TTL_SECONDS);
    expect(parseTtlParam("7200")).toBe(7200);
    expect(parseTtlParam(String(MAX_TTL_SECONDS * 2))).toBe(MAX_TTL_SECONDS);
  });

  it("resolveTtlSeconds: override wins, including never", () => {
    expect(resolveTtlSeconds(7200, undefined)).toBe(7200);
    expect(resolveTtlSeconds(NEVER_TTL, "3600")).toBe(NEVER_TTL);
  });

  it("resolveTtlSeconds: no override falls back to configured default, clamped the same way", () => {
    expect(resolveTtlSeconds(undefined, undefined)).toBe(DEFAULT_TTL_SECONDS);
    expect(resolveTtlSeconds(undefined, "bogus")).toBe(DEFAULT_TTL_SECONDS);
    expect(resolveTtlSeconds(undefined, "3600")).toBe(3600);
    // The env default is clamped to MAX just like an override (the old bug let
    // the two paths diverge between adapters).
    expect(resolveTtlSeconds(undefined, String(MAX_TTL_SECONDS * 2))).toBe(MAX_TTL_SECONDS);
  });
});
