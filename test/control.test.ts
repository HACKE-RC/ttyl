/// <reference types="node" />

import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRunningSessions,
  listSessions,
  requestStop,
  startControlServer,
  type SessionInfo,
} from "../src/client/control";

const oldRuntime = process.env.XDG_RUNTIME_DIR;
let runtimeDir = "";

beforeEach(async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), "ttyl-control-test-"));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
});

afterEach(async () => {
  if (oldRuntime === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = oldRuntime;
  }
  await rm(runtimeDir, { recursive: true, force: true });
});

describe("local control socket", () => {
  it("lists a running session and removes the marker on cleanup", async () => {
    const info = sessionInfo();
    const stop = await startControlServer(info);

    expect(await listSessions()).toEqual([info]);
    await stop();
    expect(await listSessions()).toEqual([]);
    expect(await controlEntries()).toEqual([]);
  });

  it("stops a running session via the stop command and acknowledges", async () => {
    const info = sessionInfo();
    let stopped = false;
    const stop = await startControlServer(info, () => {
      stopped = true;
    });

    const running = await listRunningSessions();
    expect(running).toHaveLength(1);
    expect(running[0].info).toEqual(info);

    const ok = await requestStop(running[0].pid);
    expect(ok).toBe(true);
    // onStop runs on a deferred tick after the ack; let it settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(true);

    // info / listSessions still work over the same protocol.
    expect(await listSessions()).toEqual([info]);
    await stop();
  });

  it("reports failure when stopping a pid with no listener", async () => {
    expect(await requestStop(999_993)).toBe(false);
  });

  it("refuses to use a group/world-accessible runtime dir", async () => {
    const dir = join(runtimeDir, "ttyl");
    await rm(dir, { recursive: true, force: true });
    await mkWorldReadableDir(dir);

    const stop = await startControlServer(sessionInfo());
    expect(await listSessions()).toEqual([]);
    await stop();
    expect(await controlEntries()).toEqual([]);
  });

  it("prunes a stale socket marker that no longer has a listener", async () => {
    const pid = 999_991;
    const path = markerPath(pid);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "");

    expect(existsSync(path)).toBe(true);
    expect(await listSessions()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it("does not prune a live socket that times out", async () => {
    const pid = 999_992;
    const path = markerPath(pid);
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // Keep the socket open without replying; listSessions should time out but
      // leave the marker in place because a listener is alive.
    });
    await listen(server, path);

    expect(await listSessions()).toEqual([]);
    expect(existsSync(path)).toBe(true);

    for (const socket of sockets) {
      socket.destroy();
    }
    await close(server);
  });
});

function sessionInfo(): SessionInfo {
  return {
    id: "SID",
    key: "KEY",
    admin: "ADMIN",
    server: "http://127.0.0.1:8080",
    viewOnly: false,
    cwd: "/tmp",
    command: "sleep 60",
    startedAt: 1,
  };
}

function markerPath(pid: number): string {
  return join(runtimeDir, "ttyl", `ttyl-${pid}.sock`);
}

async function controlEntries(): Promise<string[]> {
  try {
    return await readdir(join(runtimeDir, "ttyl"));
  } catch {
    return [];
  }
}

async function mkWorldReadableDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true, mode: 0o777 });
  await chmod(path, 0o777);
}

async function listen(server: Server, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
