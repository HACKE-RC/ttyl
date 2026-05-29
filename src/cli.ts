#!/usr/bin/env node
// ttyl command-line entrypoint: dispatches to the streaming client, the config
// initializer, or a local relay server.
import { runStream } from "./client/stream";
import { runInit } from "./client/init";
import { startServer } from "./node/server";

const USAGE = `ttyl - share your terminal with a link

Commands:
  stream   Wrap a shell in a PTY and stream it to a relay
  init     Save the default relay server URL to your config file
  serve    Run a relay server (Node)

Flags:
  stream [-server <url>] [-view-only] [-lifetime <30m|8h|2d|never>] [-- command...]
  init   [-server <url>]
  serve  [-port <n>] [-host <addr>]
`;

// splitArgs separates flags (before "--") from a trailing command (after "--").
function splitArgs(args: string[]): { flags: string[]; command: string[] } {
  const i = args.indexOf("--");
  if (i === -1) {
    return { flags: args, command: [] };
  }
  return { flags: args.slice(0, i), command: args.slice(i + 1) };
}

// flagValue returns the value of -name/--name (as "name v" or "name=v").
function flagValue(args: string[], name: string): string | undefined {
  const forms = [`-${name}`, `--${name}`];
  for (let i = 0; i < args.length; i++) {
    for (const f of forms) {
      if (args[i] === f) {
        return args[i + 1];
      }
      if (args[i].startsWith(`${f}=`)) {
        return args[i].slice(f.length + 1);
      }
    }
  }
  return undefined;
}

function flagBool(args: string[], name: string): boolean {
  return args.includes(`-${name}`) || args.includes(`--${name}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "stream": {
      const { flags, command } = splitArgs(rest);
      await runStream({
        server: flagValue(flags, "server") ?? "",
        viewOnly: flagBool(flags, "view-only"),
        lifetime: flagValue(flags, "lifetime") ?? "",
        command,
      });
      return;
    }
    case "init": {
      await runInit({ server: flagValue(rest, "server") ?? "" });
      return;
    }
    case "serve": {
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

main().catch((err: unknown) => {
  process.stderr.write(`ttyl: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
