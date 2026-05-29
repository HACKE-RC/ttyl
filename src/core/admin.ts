// The admin control plane vocabulary: the JSON messages exchanged on the
// owner-only /ws/<id>/admin socket. This module is pure data + parsing; it
// knows nothing about sockets or the relay. Keeping the protocol here (rather
// than inline in relay.ts) means the dashboard, the CLI console, and the relay
// all agree on one definition.
//
// Unlike the data plane (binary frames in wire.ts), the control plane is small,
// infrequent, and human-facing, so plain JSON text is the right tool.

// RosterEntry describes one connected client as shown on the dashboard. ip/ua
// are best-effort and only ever surface on the owner's own screen.
export interface RosterEntry {
  id: string;
  role: "broadcaster" | "viewer";
  writer: boolean;
  joinedAt: number;
  ip?: string;
  ua?: string;
}

// Roster is the full live picture the relay pushes to admins on any change.
export interface Roster {
  type: "roster";
  clients: RosterEntry[];
  locked: boolean;
  hasPassword: boolean;
  hasBroadcaster: boolean;
}

// The relay only ever pushes the full roster to admins; every state change
// (kick/lock/password) is reflected by a fresh roster rather than a separate
// ack, so there is a single server->client message shape.
export type AdminServerMessage = Roster;

// Client -> server messages. `hello` must be first and carries the admin key.
export type AdminClientMessage =
  | { type: "hello"; key: string }
  | { type: "kick"; id: string }
  | { type: "lock" }
  | { type: "unlock" }
  | { type: "password"; value: string }
  | { type: "password"; clear: true }
  | { type: "end" };

// parseAdminMessage validates an incoming control-plane string. It returns null
// for anything malformed so the relay can ignore junk instead of throwing.
export function parseAdminMessage(text: string): AdminClientMessage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") {
    return null;
  }
  const rec = obj as Record<string, unknown>;
  switch (rec.type) {
    case "hello":
      return typeof rec.key === "string" ? { type: "hello", key: rec.key } : null;
    case "kick":
      return typeof rec.id === "string" ? { type: "kick", id: rec.id } : null;
    case "lock":
      return { type: "lock" };
    case "unlock":
      return { type: "unlock" };
    case "password":
      if (rec.clear === true) {
        return { type: "password", clear: true };
      }
      return typeof rec.value === "string" ? { type: "password", value: rec.value } : null;
    case "end":
      return { type: "end" };
    default:
      return null;
  }
}

export function serializeServerMessage(msg: AdminServerMessage): string {
  return JSON.stringify(msg);
}
