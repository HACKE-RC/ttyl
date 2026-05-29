// `ttyl init` saves the default relay server URL to the per-user config file so
// `ttyl stream` can run without -server. With no -server it prints the current
// configuration.
import { configPath, load, save } from "./config";
import { validateServerURL } from "./util";

interface InitArgs {
  server: string;
}

export async function runInit(args: InitArgs): Promise<void> {
  if (!args.server) {
    const cfg = await load();
    if (cfg.server) {
      process.stderr.write(`configured server: ${cfg.server}\n  (${configPath()})\n`);
    } else {
      process.stderr.write("no server configured. Set one with:\n  ttyl init -server <url>\n");
    }
    return;
  }

  const server = validateServerURL(args.server);
  const cfg = await load();
  cfg.server = server;
  const path = await save(cfg);
  process.stderr.write(`saved server ${server} to ${path}\n`);
}
