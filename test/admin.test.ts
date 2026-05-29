import { describe, expect, it } from "vitest";
import {
  parseAdminMessage,
  serializeServerMessage,
  type AdminServerMessage,
} from "../src/core/admin";

describe("admin control-plane parsing", () => {
  it("parses each client message type", () => {
    expect(parseAdminMessage(JSON.stringify({ type: "hello", key: "K" }))).toEqual({
      type: "hello",
      key: "K",
    });
    expect(parseAdminMessage(JSON.stringify({ type: "kick", id: "c1" }))).toEqual({
      type: "kick",
      id: "c1",
    });
    expect(parseAdminMessage(JSON.stringify({ type: "lock" }))).toEqual({ type: "lock" });
    expect(parseAdminMessage(JSON.stringify({ type: "unlock" }))).toEqual({ type: "unlock" });
    expect(parseAdminMessage(JSON.stringify({ type: "password", value: "pw" }))).toEqual({
      type: "password",
      value: "pw",
    });
    expect(parseAdminMessage(JSON.stringify({ type: "password", clear: true }))).toEqual({
      type: "password",
      clear: true,
    });
  });

  it("returns null for malformed or unknown messages", () => {
    expect(parseAdminMessage("not json")).toBeNull();
    expect(parseAdminMessage(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(parseAdminMessage(JSON.stringify({ type: "hello" }))).toBeNull();
    expect(parseAdminMessage(JSON.stringify({ type: "kick" }))).toBeNull();
    expect(parseAdminMessage(JSON.stringify(42))).toBeNull();
  });

  it("serializes server messages", () => {
    const roster: AdminServerMessage = {
      type: "roster",
      clients: [{ id: "c1", role: "viewer", writer: false, joinedAt: 1 }],
      locked: false,
      hasPassword: true,
      hasBroadcaster: true,
    };
    expect(JSON.parse(serializeServerMessage(roster))).toEqual(roster);
  });
});
