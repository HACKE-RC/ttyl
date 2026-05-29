// `ttyl admin` is the terminal-side management console: the CLI twin of the web
// dashboard. It connects to the owner-only control plane (/ws/<id>/admin),
// prints the live roster as it changes, and runs a small line-based REPL so the
// owner can kick viewers, lock new joins, and set or clear the session password
// from a second terminal.
import { createInterface } from "node:readline";
import { WebSocket } from "ws";
import type { Roster, RosterEntry } from "../core/admin";
import { resolveServer, validateServerURL } from "./util";

export interface AdminArgs {
  link: string;
  server: string;
  id: string;
  key: string;
}

const HELP = `commands:
  kick <#>          disconnect a viewer by its roster number
  lock | unlock     stop / allow new viewers joining
  password <value>  set a session password (gates all viewers)
  password clear    remove the session password
  help              show this help
  quit              leave the console (the session keeps running)
`;

export async function runAdmin(args: AdminArgs): Promise<void> {
  const { server, id, key } = await resolveTarget(args);
  if (!id || !key) {
    throw new Error("admin: need a dashboard link, or -id and -key (with -server)");
  }

  // The latest roster, kept so "kick <#>" can map a row number to a connection
  // id. Only viewers are numbered; the broadcaster shows as "*".
  let viewers: RosterEntry[] = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "ttyl> " });
  const ws = new WebSocket(adminURL(server, id));

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", key }));
    process.stderr.write(`ttyl: connected to ${server}/admin/${id}\n`);
    process.stderr.write(HELP);
    rl.prompt();
  });
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      return;
    }
    let msg: { type?: string };
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    if (msg.type === "roster") {
      const roster = msg as Roster;
      viewers = roster.clients.filter((c) => c.role !== "broadcaster");
      printRoster(roster);
      rl.prompt();
    }
  });
  ws.on("close", (code: number) => {
    if (code === 1008) {
      process.stderr.write("ttyl: access denied (invalid admin key)\n");
    } else if (code === 1000) {
      process.stderr.write("ttyl: session ended\n");
    } else {
      process.stderr.write("ttyl: disconnected\n");
    }
    rl.close();
    process.exit(code === 1008 ? 1 : 0);
  });
  ws.on("error", () => {
    process.stderr.write("ttyl: connection error\n");
    process.exit(1);
  });

  rl.on("line", (line) => {
    handleCommand(line.trim(), ws, viewers);
    rl.prompt();
  });
  rl.on("close", () => {
    try {
      ws.close();
    } catch {
      // already closing
    }
    process.exit(0);
  });
}

function handleCommand(line: string, ws: WebSocket, viewers: RosterEntry[]): void {
  if (line === "") {
    return;
  }
  const [cmd, ...rest] = line.split(/\s+/);
  switch (cmd) {
    case "kick": {
      const target = viewers[Number(rest[0]) - 1];
      if (!target) {
        process.stderr.write(`ttyl: no viewer #${rest[0]}\n`);
        return;
      }
      ws.send(JSON.stringify({ type: "kick", id: target.id }));
      return;
    }
    case "lock":
      ws.send(JSON.stringify({ type: "lock" }));
      return;
    case "unlock":
      ws.send(JSON.stringify({ type: "unlock" }));
      return;
    case "password":
      if (rest[0] === "clear") {
        ws.send(JSON.stringify({ type: "password", clear: true }));
      } else if (rest[0]) {
        ws.send(JSON.stringify({ type: "password", value: rest.join(" ") }));
      } else {
        process.stderr.write("ttyl: usage: password <value> | password clear\n");
      }
      return;
    case "help":
      process.stderr.write(HELP);
      return;
    case "quit":
    case "exit":
      ws.close();
      return;
    default:
      process.stderr.write(`ttyl: unknown command "${cmd}" (try: help)\n`);
  }
}

function printRoster(roster: Roster): void {
  const lock = roster.locked ? "LOCKED" : "open";
  const pw = roster.hasPassword ? "password set" : "no password";
  process.stdout.write(`\n--- roster (${lock}, ${pw}) ---\n`);
  if (roster.clients.length === 0) {
    process.stdout.write("  (no one connected)\n\n");
    return;
  }
  let n = 0;
  for (const c of roster.clients) {
    const access = c.role === "broadcaster" ? "host" : c.writer ? "read-write" : "view-only";
    const label = c.role === "broadcaster" ? "  *" : `  ${++n}`;
    const where = c.ip ? ` ${c.ip}` : "";
    process.stdout.write(`${label}. ${access}${where}\n`);
  }
  process.stdout.write("\n");
}

async function resolveTarget(args: AdminArgs): Promise<{ server: string; id: string; key: string }> {
  if (args.link) {
    const u = new URL(args.link);
    const m = u.pathname.match(/^\/admin\/([^/]+)$/);
    const key = u.hash ? decodeURIComponent(u.hash.replace(/^#/, "")) : "";
    return { server: `${u.protocol}//${u.host}`, id: m ? m[1] : "", key };
  }
  const server = args.server ? validateServerURL(args.server) : await resolveServer("");
  return { server, id: args.id, key: args.key };
}

function adminURL(server: string, id: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `/ws/${id}/admin`;
  u.search = "";
  u.hash = "";
  return u.toString();
}
