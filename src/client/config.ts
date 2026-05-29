// Persists client settings (currently the default relay server URL) to a small
// JSON file in the user's OS config directory, so the server need not be passed
// on every stream. Locations follow each platform's convention:
//   Linux/BSD: $XDG_CONFIG_HOME/ttyl/config.json (or ~/.config/ttyl/...)
//   macOS:     ~/Library/Application Support/ttyl/config.json
//   Windows:   %AppData%\ttyl\config.json
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  server?: string;
}

function configDir(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

export function configPath(): string {
  return join(configDir(), "ttyl", "config.json");
}

// load reads the config file; a missing file yields an empty config so callers
// fall back to defaults.
export async function load(): Promise<Config> {
  try {
    const data = await readFile(configPath(), "utf8");
    return JSON.parse(data) as Config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

// save writes the config file, creating the directory if needed, and returns
// the path written.
export async function save(config: Config): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
