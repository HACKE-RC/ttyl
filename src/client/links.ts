// `ttyl links` reprints the links for streams running on this machine. It is the
// recovery path for the dashboard/share links once they have scrolled away: the
// links are shown only once at stream start, but every running broadcaster keeps
// serving them on a local control socket (see control.ts).
import { listSessions } from "./control";
import { linkLines } from "./util";

export async function runLinks(): Promise<void> {
  const sessions = await listSessions();
  if (sessions.length === 0) {
    process.stderr.write("ttyl: no running session found.\n  Start one with: ttyl stream\n");
    return;
  }

  const many = sessions.length > 1;
  for (const s of sessions) {
    if (many) {
      const label = s.command || "session";
      process.stdout.write(`# ${label}  (${s.cwd})\n`);
    }
    for (const line of linkLines(s.server, s.id, s.key, s.admin, s.viewOnly)) {
      process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write("\n");
  }
}
