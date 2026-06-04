#!/usr/bin/env node
// ttyl command-line entrypoint: dispatches to the streaming client, the config
// initializer, or a local relay server. Command modules are imported lazily so,
// e.g., `serve` and `init` do not load the streaming client's native PTY dep.
import { flagBool, flagValue, splitArgs } from "./args";

const USAGE = `ttyl - share your terminal with a link

Commands:
  stream   Wrap a shell in a PTY and stream it to a relay
  record   Record a local terminal command to MP4/WebM
  links    Reprint the links for streams running on this machine
  stop     Stop a stream running on this machine
  admin    Open the management console for a running session
  init     Save the default relay server URL to your config file
  serve    Run a relay server (Node)

Flags:
  stream [--server <url>] [--view-only] [--password] [--lifetime <30m|8h|2d|never>] [--size <80x24>] [--follow-terminal-size] [-- command...]
  record [--output <file>] [--size <80x24>] [--fps <n>] [--font-size <px>] [-- command...]
  stop   [<session-id>]
  admin  [<dashboard-link>] [--server <url>] [--id <id>] [--key <admin-key>]
  init   [--server <url>]
  serve  [--port <n>] [--host <addr>]
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "stream": {
      const { flags, command } = splitArgs(rest);
      const { runStream } = await import("./client/stream");
      await runStream({
        server: flagValue(flags, "-server", "--server") ?? "",
        viewOnly: flagBool(flags, "-view-only", "--view-only"),
        password: flagBool(flags, "-password", "--password"),
        lifetime: flagValue(flags, "-lifetime", "--lifetime") ?? "",
        size: flagValue(flags, "-size", "--size") ?? "",
        followTerminalSize: flagBool(flags, "-follow-terminal-size", "--follow-terminal-size"),
        command,
      });
      return;
    }
    case "record": {
      const { flags, command } = splitArgs(rest);
      if (flagBool(flags, "-h", "--help")) {
        process.stdout.write(USAGE);
        return;
      }
      const { runRecord } = await import("./client/record");
      await runRecord({
        output: flagValue(flags, "-output", "--output") ?? "",
        size: flagValue(flags, "-size", "--size") ?? "",
        fps: flagValue(flags, "-fps", "--fps") ?? "",
        fontSize: flagValue(flags, "-font-size", "--font-size") ?? "",
        command,
      });
      return;
    }
    case "links": {
      const { runLinks } = await import("./client/links");
      await runLinks();
      return;
    }
    case "stop": {
      const { runStop } = await import("./client/stop");
      await runStop(rest.find((arg) => !arg.startsWith("-")));
      return;
    }
    case "admin": {
      const { runAdmin } = await import("./client/admin");
      await runAdmin({
        link: positionalLink(rest),
        server: flagValue(rest, "-server", "--server") ?? "",
        id: flagValue(rest, "-id", "--id") ?? "",
        key: flagValue(rest, "-key", "--key") ?? "",
      });
      return;
    }
    case "init": {
      const { runInit } = await import("./client/init");
      await runInit({ server: flagValue(rest, "-server", "--server") ?? "" });
      return;
    }
    case "serve": {
      const { startServer } = await import("./node/server");
      startServer(rest);
      return;
    }
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return;
    case undefined:
      process.stderr.write(USAGE);
      process.exit(2);
      return;
    default:
      process.stderr.write(`ttyl: unknown command "${cmd}"\n\n${USAGE}`);
      process.exit(2);
  }
}

function positionalLink(args: string[]): string {
  const valueFlags = new Set(["-server", "--server", "-id", "--id", "-key", "--key"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if ([...valueFlags].some((flag) => arg.startsWith(`${flag}=`))) {
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return "";
}

main().catch((err: unknown) => {
  process.stderr.write(`ttyl: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
