#!/usr/bin/env node
// ttyl command-line entrypoint: dispatches to the streaming client, the config
// initializer, or a local relay server. Command modules are imported lazily so,
// e.g., `serve` and `init` do not load the streaming client's native PTY dep.
import { flagBool, flagValue, splitArgs } from "./args";

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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "stream": {
      const { flags, command } = splitArgs(rest);
      const { runStream } = await import("./client/stream");
      await runStream({
        server: flagValue(flags, "-server", "--server") ?? "",
        viewOnly: flagBool(flags, "-view-only", "--view-only"),
        lifetime: flagValue(flags, "-lifetime", "--lifetime") ?? "",
        command,
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

main().catch((err: unknown) => {
  process.stderr.write(`ttyl: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
