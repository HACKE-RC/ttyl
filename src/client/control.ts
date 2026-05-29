// A tiny local control channel so a running `ttyl stream` can hand its links to
// another command (`ttyl links`) on the same machine. This is what lets you
// recover the dashboard/share links after they have scrolled off screen.
//
// Each broadcaster listens on a per-PID socket in a user-private runtime dir
// (a Unix domain socket on Linux/macOS, a named pipe on Windows). The socket is
// named only by PID, which is not a secret; the session tokens travel over the
// in-memory IPC channel and are never written to a file, so the "nothing on
// disk" promise holds.
//
// On Unix the directory is verified to be owned by us with no group/other access
// before we trust or write into it, so a foreign user cannot pre-create it (in a
// shared /tmp) to read the tokens or feed `ttyl links` spoofed URLs. On Windows
// the named pipe uses the default pipe ACL; treat that as a weaker boundary.
import { createServer, connect, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SessionInfo is everything `ttyl links` needs to reprint a session's links and
// tell concurrent sessions apart.
export interface SessionInfo {
  id: string;
  key: string;
  admin: string;
  server: string;
  viewOnly: boolean;
  cwd: string;
  command: string;
  startedAt: number;
}

const PREFIX = "ttyl-";
const SUFFIX = ".sock";
// A pid-named socket: "ttyl-<digits>.sock" and nothing else.
const SOCK_RE = /^ttyl-(\d+)\.sock$/;
// Give up quickly on a socket that does not answer; a slow/dead peer should not
// hang `ttyl links`.
const QUERY_TIMEOUT_MS = 1000;

// controlDir is the user-private directory holding the per-session sockets. It
// is per-uid when it has to live under a shared temp dir, so two users never
// share one directory.
function controlDir(): string {
  if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, "ttyl");
  }
  const uid = process.getuid?.();
  return join(tmpdir(), uid === undefined ? "ttyl" : `ttyl-${uid}`);
}

// secureDir resolves the control dir and refuses it unless it is a real
// directory we own with no access for group/other. Returns null when it cannot
// be trusted (or created), so callers fail closed: recovery is simply skipped
// rather than leaking tokens through a directory someone else controls.
async function secureDir(create: boolean): Promise<string | null> {
  const dir = controlDir();
  try {
    if (create) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const st = await lstat(dir);
    if (!st.isDirectory()) {
      return null; // not a dir, or a symlink pointing elsewhere
    }
    if (process.platform !== "win32") {
      const uid = process.getuid?.();
      if (uid !== undefined && st.uid !== uid) {
        return null; // owned by someone else
      }
      if ((st.mode & 0o077) !== 0) {
        return null; // group/other can access
      }
    }
    return dir;
  } catch {
    return null;
  }
}

function markerPath(pid: number): string {
  return join(controlDir(), `${PREFIX}${pid}${SUFFIX}`);
}

// listenPath is where the server actually listens: the marker file on Unix, a
// named pipe on Windows.
function listenPath(pid: number): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ttyl-${pid}`;
  }
  return markerPath(pid);
}

// startControlServer publishes info on this process's control socket and returns
// a cleanup function that closes and removes it. It never throws: if the channel
// cannot be created (or the dir is not trustworthy), recovery via `ttyl links`
// is simply unavailable.
export async function startControlServer(info: SessionInfo): Promise<() => Promise<void>> {
  const noop = async (): Promise<void> => {};
  const dir = await secureDir(true);
  if (!dir) {
    return noop;
  }
  try {
    const pid = process.pid;
    const marker = markerPath(pid);
    if (process.platform !== "win32") {
      await unlink(marker).catch(() => {}); // clear any stale file at our path
    }

    const payload = JSON.stringify(info);
    const server = createServer((sock: Socket) => {
      sock.end(payload);
    });
    server.on("error", () => {}); // best effort; ignore late socket errors

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      server.once("error", onError);
      server.listen(listenPath(pid), () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    if (process.platform === "win32") {
      await writeFile(marker, "", { mode: 0o600 }).catch(() => {});
    } else {
      await chmod(marker, 0o600).catch(() => {});
    }

    return async () => {
      // Remove the marker synchronously first so a concurrent `ttyl links` does
      // not even try a socket we are tearing down, then close the server.
      try {
        unlinkSync(marker);
      } catch {
        // already gone
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  } catch {
    return noop;
  }
}

// listSessions discovers every running broadcaster for this user, querying each
// control socket in parallel. A socket that is refused/missing is stale and gets
// pruned; one that merely answers slowly is left alone.
export async function listSessions(): Promise<SessionInfo[]> {
  const dir = await secureDir(false);
  if (!dir) {
    return [];
  }
  const entries = await readdir(dir).catch(() => [] as string[]);
  const found = entries
    .map((entry) => ({ entry, match: SOCK_RE.exec(entry) }))
    .filter((x): x is { entry: string; match: RegExpExecArray } => x.match !== null)
    .map((x) => ({ entry: x.entry, pid: Number(x.match[1]) }));

  type QueryResult =
    | { ok: true; info: SessionInfo }
    | { ok: false; entry: string; err: unknown };
  const results = await Promise.all(
    found.map(async ({ entry, pid }): Promise<QueryResult> => {
      try {
        return { ok: true, info: await query(pid) };
      } catch (err) {
        return { ok: false, entry, err };
      }
    }),
  );

  const sessions: SessionInfo[] = [];
  for (const r of results) {
    if (r.ok) {
      sessions.push(r.info);
    } else if (isDeadSocket(r.err)) {
      await unlink(join(dir, r.entry)).catch(() => {});
    }
  }
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  return sessions;
}

// isDeadSocket is true only for errors that mean "nothing is listening here",
// so a live-but-busy session is never pruned.
function isDeadSocket(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "ENOTSOCK";
}

function query(pid: number): Promise<SessionInfo> {
  return new Promise((resolve, reject) => {
    const sock = connect(listenPath(pid));
    let data = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timeout")); // no errno code => not treated as dead
    }, QUERY_TIMEOUT_MS);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      data += chunk;
    });
    sock.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data) as SessionInfo);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("parse error"));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
