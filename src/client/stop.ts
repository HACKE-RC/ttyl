// `ttyl stop` shuts down a running `ttyl stream` on this machine. It is the
// counterpart to `ttyl links`: both discover broadcasters via the local control
// socket (see control.ts), but `stop` sends a command instead of just reading.
// With one running session it stops it; with several it requires an explicit
// session id so you cannot tear down the wrong one by accident.
import { listRunningSessions, requestStop } from "./control";

export async function runStop(selector?: string): Promise<void> {
  const sessions = await listRunningSessions();
  if (sessions.length === 0) {
    process.stderr.write("ttyl: no running session found.\n  Start one with: ttyl stream\n");
    return;
  }

  if (selector) {
    const target = sessions.find((s) => s.info.id === selector);
    if (!target) {
      process.stderr.write(`ttyl: no running session with id "${selector}"\n`);
      printSessions(sessions);
      process.exitCode = 1;
      return;
    }
    await stopOne(target.pid, target.info.id);
    return;
  }

  if (sessions.length > 1) {
    process.stderr.write("ttyl: multiple sessions running; pass an id to choose one:\n");
    printSessions(sessions);
    process.stderr.write("\n  ttyl stop <id>\n");
    process.exitCode = 1;
    return;
  }

  const only = sessions[0];
  await stopOne(only.pid, only.info.id);
}

async function stopOne(pid: number, id: string): Promise<void> {
  const ok = await requestStop(pid);
  if (ok) {
    process.stdout.write(`ttyl: stopped session ${id}\n`);
  } else {
    process.stderr.write(`ttyl: could not stop session ${id} (it may have already exited)\n`);
    process.exitCode = 1;
  }
}

function printSessions(sessions: Awaited<ReturnType<typeof listRunningSessions>>): void {
  for (const { info } of sessions) {
    const label = info.command || "session";
    process.stderr.write(`  ${info.id}  ${label}  (${info.cwd})\n`);
  }
}
