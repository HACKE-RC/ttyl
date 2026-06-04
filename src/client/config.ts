// Persists client settings to a small JSON file in the user's OS config
// directory, so common stream and recording options need not be passed every
// time. Locations follow each platform's convention:
//   Linux/BSD: $XDG_CONFIG_HOME/ttyl/config.json (or ~/.config/ttyl/...)
//   macOS:     ~/Library/Application Support/ttyl/config.json
//   Windows:   %AppData%\ttyl\config.json
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  server?: string;
  record?: RecordConfig;
}

export interface RecordConfig {
  output?: string;
  size?: string;
  fps?: number | string;
  fontSize?: number | string;
  fontFamily?: string;
  cellWidth?: number | string;
  cellHeight?: number | string;
  paddingX?: number | string;
  paddingY?: number | string;
  theme?: RecordThemeConfig;
}

export interface RecordThemeConfig {
  foreground?: string;
  background?: string;
  cursor?: string;
  ansi?: string[];
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

// load reads the config file; a missing or corrupt file yields an empty config
// so callers fall back to defaults rather than failing every command.
export async function load(): Promise<Config> {
  let data: string;
  try {
    data = await readFile(configPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  try {
    return JSON.parse(data) as Config;
  } catch {
    process.stderr.write(`ttyl: ignoring unreadable config at ${configPath()}\n`);
    return {};
  }
}

// save writes the config file, creating the directory if needed, and returns
// the path written.
export async function save(config: Config): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
