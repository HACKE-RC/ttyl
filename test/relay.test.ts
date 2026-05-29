import { describe, expect, it } from "vitest";
import {
  CLOSE_KICKED,
  CLOSE_LOCKED,
  CLOSE_PASSWORD_INCORRECT,
  CLOSE_PASSWORD_REQUIRED,
  CLOSE_TOO_MANY_ATTEMPTS,
  Relay,
  type Conn,
  type Role,
} from "../src/core/relay";
import { encode, Kind, decode } from "../src/core/wire";
import { encodeAuthPayload, hashPassword } from "../src/core/auth";
import { type Roster } from "../src/core/admin";

// StubConn is an in-memory Conn that records everything the relay sends and the
// close code it received. The pure core makes this kind of test trivial.
class StubConn implements Conn {
  authed = false;
  writer = false;
  id = "";
  meta?: { ip?: string; ua?: string };
  sent: Uint8Array[] = [];
  texts: string[] = [];
  closedCode: number | null = null;
  closedReason = "";

  constructor(public readonly role: Role) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  sendText(text: string): void {
    this.texts.push(text);
  }
  close(code: number, reason: string): void {
    if (this.closedCode === null) {
      this.closedCode = code;
      this.closedReason = reason;
    }
  }

  lastRoster(): Roster | null {
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const obj = JSON.parse(this.texts[i]);
      if (obj.type === "roster") {
        return obj as Roster;
      }
    }
    return null;
  }
}

const CONTROL = "CONTROLKEY";
const ADMIN = "ADMINKEY";

function newRelay(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}) {
  let ended = false;
  const persisted: { password: unknown; locked: boolean }[] = [];
  const opts = makeOptions({
    onEnd: () => {
      ended = true;
    },
    onPersist: (s) => persisted.push(s),
    ...overrides,
  });
  return { relay: new Relay(opts), isEnded: () => ended, persisted };
}

function makeOptions(o: {
  onEnd: () => void;
  onPersist?: (s: { password: unknown; locked: boolean }) => void;
  password?: Awaited<ReturnType<typeof hashPassword>> | null;
  locked?: boolean;
}) {
  return {
    controlKey: CONTROL,
    adminKey: ADMIN,
    password: o.password ?? null,
    locked: o.locked ?? false,
    onEnd: o.onEnd,
    onPersist: o.onPersist,
  };
}

function auth(payload: { k?: string; p?: string }): Uint8Array {
  return encode({ kind: Kind.Auth, data: encodeAuthPayload(payload) });
}

describe("relay handshake roles", () => {
  it("admits a broadcaster with the control key and rejects a wrong key", () => {
    const { relay } = newRelay();
    const bad = new StubConn("broadcaster");
    relay.message(bad, auth({ k: "nope" }));
    expect(bad.closedCode).toBe(1008);

    const bc = new StubConn("broadcaster");
    relay.message(bc, auth({ k: CONTROL }));
    expect(bc.authed).toBe(true);
    expect(relay.hasBroadcaster).toBe(true);
  });

  it("grants typing to a viewer with the control key and view-only otherwise", () => {
    const { relay } = newRelay();
    const writer = new StubConn("viewer");
    relay.message(writer, auth({ k: CONTROL }));
    expect(writer.authed).toBe(true);
    expect(writer.writer).toBe(true);

    const ro = new StubConn("viewer");
    relay.message(ro, auth({}));
    expect(ro.authed).toBe(true);
    expect(ro.writer).toBe(false);
  });

  it("rejects an admin with a wrong key and accepts the admin key", () => {
    const { relay } = newRelay();
    const bad = new StubConn("admin");
    relay.controlMessage(bad, JSON.stringify({ type: "hello", key: "nope" }));
    expect(bad.closedCode).toBe(1008);

    const admin = new StubConn("admin");
    relay.controlMessage(admin, JSON.stringify({ type: "hello", key: ADMIN }));
    expect(admin.authed).toBe(true);
    expect(admin.lastRoster()).not.toBeNull();
  });
});

describe("relay roster + kick", () => {
  it("reports broadcaster and viewers to admins and supports kick", () => {
    const { relay } = newRelay();
    const admin = new StubConn("admin");
    relay.controlMessage(admin, JSON.stringify({ type: "hello", key: ADMIN }));

    const bc = new StubConn("broadcaster");
    relay.message(bc, auth({ k: CONTROL }));
    const v = new StubConn("viewer");
    v.meta = { ip: "1.2.3.4", ua: "test" };
    relay.message(v, auth({}));

    const roster = admin.lastRoster();
    expect(roster?.hasBroadcaster).toBe(true);
    expect(roster?.clients.length).toBe(2);
    const viewerEntry = roster?.clients.find((c) => c.role === "viewer");
    expect(viewerEntry?.ip).toBe("1.2.3.4");

    // Kick the viewer by its assigned id.
    relay.controlMessage(admin, JSON.stringify({ type: "kick", id: v.id }));
    expect(v.closedCode).toBe(CLOSE_KICKED);
    relay.close(v); // adapter would call this on socket close
    expect(admin.lastRoster()?.clients.some((c) => c.role === "viewer")).toBe(false);
  });
});

describe("relay lock", () => {
  it("refuses new viewers when locked", () => {
    const { relay, persisted } = newRelay();
    const admin = new StubConn("admin");
    relay.controlMessage(admin, JSON.stringify({ type: "hello", key: ADMIN }));
    relay.controlMessage(admin, JSON.stringify({ type: "lock" }));
    expect(persisted.at(-1)?.locked).toBe(true);

    const v = new StubConn("viewer");
    relay.message(v, auth({}));
    expect(v.closedCode).toBe(CLOSE_LOCKED);

    relay.controlMessage(admin, JSON.stringify({ type: "unlock" }));
    const v2 = new StubConn("viewer");
    relay.message(v2, auth({}));
    expect(v2.authed).toBe(true);
  });
});

describe("relay password gate", () => {
  it("requires the correct password for viewers", async () => {
    const password = await hashPassword("s3cret");
    const { relay } = newRelay({ password });

    const missing = new StubConn("viewer");
    relay.message(missing, auth({}));
    expect(missing.closedCode).toBe(CLOSE_PASSWORD_REQUIRED);

    const wrong = new StubConn("viewer");
    relay.message(wrong, auth({ p: "nope" }));
    await flush();
    expect(wrong.closedCode).toBe(CLOSE_PASSWORD_INCORRECT);

    const ok = new StubConn("viewer");
    relay.message(ok, auth({ p: "s3cret" }));
    await flush();
    expect(ok.authed).toBe(true);
  });

  it("does not gate the broadcaster", async () => {
    const password = await hashPassword("s3cret");
    const { relay } = newRelay({ password });
    const bc = new StubConn("broadcaster");
    relay.message(bc, auth({ k: CONTROL }));
    expect(bc.authed).toBe(true);
  });

  it("lets an admin set and clear the password", async () => {
    const { relay } = newRelay();
    const admin = new StubConn("admin");
    relay.controlMessage(admin, JSON.stringify({ type: "hello", key: ADMIN }));
    relay.controlMessage(admin, JSON.stringify({ type: "password", value: "newpw" }));
    await flush();
    expect(admin.lastRoster()?.hasPassword).toBe(true);

    const v = new StubConn("viewer");
    relay.message(v, auth({ p: "newpw" }));
    await flush();
    expect(v.authed).toBe(true);

    relay.controlMessage(admin, JSON.stringify({ type: "password", clear: true }));
    expect(admin.lastRoster()?.hasPassword).toBe(false);
  });

  it("lets a clear win over an in-flight set (last intent wins)", async () => {
    const { relay } = newRelay();
    const admin = new StubConn("admin");
    relay.controlMessage(admin, JSON.stringify({ type: "hello", key: ADMIN }));
    // Start an async set, then immediately clear before its hash resolves.
    relay.controlMessage(admin, JSON.stringify({ type: "password", value: "race" }));
    relay.controlMessage(admin, JSON.stringify({ type: "password", clear: true }));
    await flush();
    expect(admin.lastRoster()?.hasPassword).toBe(false);

    // And a view-only viewer is admitted without a password.
    const v = new StubConn("viewer");
    relay.message(v, auth({}));
    expect(v.authed).toBe(true);
  });

  it("does not admit a viewer if the session locks during password verification", async () => {
    const password = await hashPassword("s3cret");
    const { relay } = newRelay({ password });
    const admin = new StubConn("admin");
    relay.controlMessage(admin, JSON.stringify({ type: "hello", key: ADMIN }));

    const v = new StubConn("viewer");
    relay.message(v, auth({ p: "s3cret" }));
    relay.controlMessage(admin, JSON.stringify({ type: "lock" }));
    await flush();

    expect(v.authed).toBe(false);
    expect(v.closedCode).toBe(CLOSE_LOCKED);
  });

  it("does not admit a viewer if the password policy changes during verification", async () => {
    const password = await hashPassword("old");
    const { relay } = newRelay({ password });
    const admin = new StubConn("admin");
    relay.controlMessage(admin, JSON.stringify({ type: "hello", key: ADMIN }));

    const v = new StubConn("viewer");
    relay.message(v, auth({ p: "old" }));
    relay.controlMessage(admin, JSON.stringify({ type: "password", clear: true }));
    await flush();

    expect(v.authed).toBe(false);
    expect(v.closedCode).toBe(CLOSE_PASSWORD_REQUIRED);
  });

  it("counts pending password attempts toward the throttle", async () => {
    const password = await hashPassword("s3cret");
    const { relay } = newRelay({ password });
    const attempts = Array.from({ length: 6 }, () => new StubConn("viewer"));

    for (const conn of attempts) {
      relay.message(conn, auth({ p: "wrong" }));
    }

    expect(attempts[5].closedCode).toBe(CLOSE_TOO_MANY_ATTEMPTS);
    await flush();
    expect(attempts.slice(0, 5).every((c) => c.closedCode === CLOSE_PASSWORD_INCORRECT)).toBe(
      true,
    );
  });
});

describe("relay data plane unchanged", () => {
  it("fans out output to viewers and routes writer input to the broadcaster", () => {
    const { relay } = newRelay();
    const bc = new StubConn("broadcaster");
    relay.message(bc, auth({ k: CONTROL }));
    const v = new StubConn("viewer");
    relay.message(v, auth({ k: CONTROL }));

    const out = encode({ kind: Kind.Output, data: new TextEncoder().encode("hi") });
    relay.message(bc, out);
    expect(v.sent.some((b) => decode(b).kind === Kind.Output)).toBe(true);

    const input = encode({ kind: Kind.Input, data: new TextEncoder().encode("ls\n") });
    relay.message(v, input);
    expect(bc.sent.some((b) => decode(b).kind === Kind.Input)).toBe(true);
  });

  it("ends the session when the broadcaster leaves", () => {
    const { relay, isEnded } = newRelay();
    const bc = new StubConn("broadcaster");
    relay.message(bc, auth({ k: CONTROL }));
    relay.close(bc);
    expect(isEnded()).toBe(true);
  });
});

// flush waits long enough for the async PBKDF2 hash/verify to settle.
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 400));
}
