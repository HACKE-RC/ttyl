import { appendFile, mkdir, open, readFile, readdir, stat, writeFile, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  TTYLVAULT_EVENTS_FILE,
  TTYLVAULT_MANIFEST_FILE,
  TTYLVAULT_TRANSCRIPT_FILE,
  type VaultEvent,
  type VaultManifest,
  type VaultPayload,
} from "../core/vault";

export { TTYLVAULT_EVENTS_FILE, TTYLVAULT_MANIFEST_FILE, TTYLVAULT_TRANSCRIPT_FILE };

export interface TtylVaultCliArgs {
  vault: boolean;
  vaultOutput: string;
}

export interface TtylVaultSettings {
  enabled: boolean;
  dir: string;
}

export interface TtylVaultSession {
  command: string[];
  cwd: string;
  outputVideo: string;
  terminal: {
    cols: number;
    rows: number;
  };
  recording: {
    preset: string;
    fps: number;
    fontSize: number;
    fontFamily: string;
  };
}

export interface TtylVaultWriter {
  enabled: boolean;
  dir: string;
  writeResize(cols: number, rows: number): void;
  writeData(chunk: Buffer): void;
  finish(exitCode: number): Promise<void>;
  abort(): Promise<void>;
}

export interface VaultRegistryEntry {
  id: string;
  dir: string;
  createdAt: string;
  command: string[];
  outputVideo: string;
}

const INDEX_FILE = "index.jsonl";
const NOOP_VAULT: TtylVaultWriter = {
  enabled: false,
  dir: "",
  writeResize() {
    // disabled
  },
  writeData() {
    // disabled
  },
  async finish() {
    // disabled
  },
  async abort() {
    // disabled
  },
};

export function resolveTtylVaultSettings(
  args: TtylVaultCliArgs,
  outputVideo: string,
): TtylVaultSettings {
  const requested = args.vault || args.vaultOutput.trim() !== "";
  if (!requested) {
    return { enabled: false, dir: "" };
  }
  return {
    enabled: true,
    dir: resolve(args.vaultOutput || defaultTtylVaultDir(outputVideo)),
  };
}

export function defaultTtylVaultDir(outputVideo: string, now = new Date()): string {
  const output = resolve(outputVideo);
  const ext = extname(output);
  const stem = sanitizeName(ext ? basename(output, ext) : basename(output));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(vaultStoreDir(), `${stamp}-${stem || "session"}.ttylvault`);
}

export function vaultStoreDir(): string {
  const dataRoot =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
      : process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataRoot, "ttyl", "vaults");
}

export async function createTtylVaultWriter(
  vault: TtylVaultSettings,
  session: TtylVaultSession,
): Promise<TtylVaultWriter> {
  if (!vault.enabled) {
    return NOOP_VAULT;
  }
  await mkdir(vault.dir, { recursive: true, mode: 0o700 });
  const events = await open(join(vault.dir, TTYLVAULT_EVENTS_FILE), "w", 0o600);
  const transcript = await open(join(vault.dir, TTYLVAULT_TRANSCRIPT_FILE), "w", 0o600);
  const writer = new FileTtylVaultWriter(vault.dir, events, transcript, session);
  await writer.start();
  return writer;
}

export async function readVaultManifest(vaultDir: string): Promise<VaultManifest> {
  const manifest = JSON.parse(await readFile(join(resolve(vaultDir), TTYLVAULT_MANIFEST_FILE), "utf8")) as VaultManifest;
  if (manifest.schemaVersion !== 1 || manifest.format !== "ttylvault") {
    throw new Error(`invalid ttylvault manifest at ${vaultDir}`);
  }
  return manifest;
}

export async function readVaultEvents(vaultDir: string): Promise<VaultEvent[]> {
  const path = join(resolve(vaultDir), TTYLVAULT_EVENTS_FILE);
  const text = await readFile(path, "utf8");
  return text
    .split(/\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as VaultEvent);
}

export async function readVaultTranscript(vaultDir: string): Promise<string> {
  try {
    return await readFile(join(resolve(vaultDir), TTYLVAULT_TRANSCRIPT_FILE), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return transcriptFromEvents(await readVaultEvents(vaultDir));
  }
}

export async function loadVaultPayload(vaultDir: string): Promise<VaultPayload> {
  const dir = resolve(vaultDir);
  return {
    schemaVersion: 1,
    format: "ttylvault-share",
    manifest: await readVaultManifest(dir),
    events: await readVaultEvents(dir),
    transcript: await readVaultTranscript(dir),
  };
}

export function transcriptFromEvents(events: VaultEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type === "data") {
      chunks.push(sanitizeTranscript(Buffer.from(event.data, "base64").toString("utf8")));
    }
  }
  return chunks.join("");
}

export async function listVaults(dir = vaultStoreDir()): Promise<VaultRegistryEntry[]> {
  const seen = new Set<string>();
  const entries: VaultRegistryEntry[] = [];
  for (const entry of await readRegistry()) {
    if (seen.has(entry.dir)) {
      continue;
    }
    seen.add(entry.dir);
    if (await hasManifest(entry.dir)) {
      entries.push(entry);
    }
  }
  for (const vaultDir of await discoverVaultDirs(dir)) {
    if (seen.has(vaultDir)) {
      continue;
    }
    try {
      const manifest = await readVaultManifest(vaultDir);
      entries.push(registryEntry(vaultDir, manifest));
      seen.add(vaultDir);
    } catch {
      // ignore invalid directories
    }
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function writeRegistryEntry(vaultDir: string, manifest: VaultManifest): Promise<void> {
  const store = vaultStoreDir();
  await mkdir(store, { recursive: true, mode: 0o700 });
  await appendFile(join(store, INDEX_FILE), `${JSON.stringify(registryEntry(vaultDir, manifest))}\n`, {
    mode: 0o600,
  });
}

export async function findVault(input: string): Promise<string> {
  const explicit = resolve(input);
  if (await hasManifest(explicit)) {
    return explicit;
  }
  for (const entry of await listVaults()) {
    if (entry.id === input || basename(entry.dir) === input) {
      return entry.dir;
    }
  }
  throw new Error(`vault not found: ${input}`);
}

export function eventsToAsciicast(manifest: VaultManifest, events: VaultEvent[]): string {
  const header = {
    version: 2,
    width: manifest.terminal.cols,
    height: manifest.terminal.rows,
    timestamp: Math.floor(new Date(manifest.createdAt).getTime() / 1000),
    command: manifest.command.join(" "),
    env: { TERM: "xterm-256color" },
  };
  const lines = [JSON.stringify(header)];
  for (const event of events) {
    if (event.type === "data") {
      lines.push(JSON.stringify([event.elapsedMs / 1000, "o", Buffer.from(event.data, "base64").toString("utf8")]));
    } else if (event.type === "resize") {
      lines.push(JSON.stringify([event.elapsedMs / 1000, "r", `${event.cols}x${event.rows}`]));
    }
  }
  return `${lines.join("\n")}\n`;
}

class FileTtylVaultWriter implements TtylVaultWriter {
  enabled = true;
  private readonly id = newSessionId();
  private readonly startedAt = Date.now();
  private readonly createdAt = new Date(this.startedAt).toISOString();
  private pending = Promise.resolve();
  private closed = false;
  private eventCount = 0;
  private byteCount = 0;
  private transcriptBytes = 0;
  private durationMs = 0;

  constructor(
    readonly dir: string,
    private readonly events: FileHandle,
    private readonly transcript: FileHandle,
    private readonly session: TtylVaultSession,
  ) {}

  async start(): Promise<void> {
    await this.writeManifest("running");
    await this.enqueue({ type: "start", time: this.createdAt, elapsedMs: 0 });
    this.writeResize(this.session.terminal.cols, this.session.terminal.rows);
  }

  writeResize(cols: number, rows: number): void {
    const event = this.eventBase("resize");
    this.pending = this.pending.then(() => this.writeEvent({ ...event, cols, rows }));
  }

  writeData(chunk: Buffer): void {
    const event = this.eventBase("data");
    const transcript = sanitizeTranscript(chunk.toString("utf8"));
    this.byteCount += chunk.byteLength;
    this.transcriptBytes += Buffer.byteLength(transcript);
    this.pending = this.pending.then(async () => {
      await this.writeEvent({
        ...event,
        encoding: "base64",
        data: chunk.toString("base64"),
      });
      if (transcript) {
        await this.transcript.write(transcript);
      }
    });
  }

  async finish(exitCode: number): Promise<void> {
    if (this.closed) {
      return;
    }
    const event = this.eventBase("exit");
    await this.enqueue({ ...event, exitCode });
    await this.events.close();
    await this.transcript.close();
    this.closed = true;
    const manifest = await this.writeManifest("finished", exitCode, event.time);
    await writeRegistryEntry(this.dir, manifest);
  }

  async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.enqueue(this.eventBase("abort"));
    } finally {
      await this.events.close().catch(() => {
        // best-effort cleanup during failure paths
      });
      await this.transcript.close().catch(() => {
        // best-effort cleanup during failure paths
      });
      this.closed = true;
      await this.writeManifest("aborted").catch(() => {
        // preserve the original recording error if manifest rewrite fails
      });
    }
  }

  private eventBase<T extends VaultEvent["type"]>(type: T): Extract<VaultEvent, { type: T }> {
    const now = Date.now();
    this.durationMs = now - this.startedAt;
    return {
      type,
      time: new Date(now).toISOString(),
      elapsedMs: this.durationMs,
    } as Extract<VaultEvent, { type: T }>;
  }

  private enqueue(event: VaultEvent): Promise<void> {
    this.pending = this.pending.then(() => this.writeEvent(event));
    return this.pending;
  }

  private async writeEvent(event: VaultEvent): Promise<void> {
    this.eventCount++;
    await this.events.write(`${JSON.stringify(event)}\n`);
  }

  private async writeManifest(
    status: VaultManifest["status"],
    exitCode?: number,
    finishedAt?: string,
  ): Promise<VaultManifest> {
    const manifest: VaultManifest = {
      schemaVersion: 1,
      format: "ttylvault",
      id: this.id,
      status,
      createdAt: this.createdAt,
      finishedAt,
      command: this.session.command,
      cwd: this.session.cwd,
      outputVideo: this.session.outputVideo,
      exitCode,
      files: {
        events: TTYLVAULT_EVENTS_FILE,
        transcript: TTYLVAULT_TRANSCRIPT_FILE,
      },
      terminal: {
        cols: this.session.terminal.cols,
        rows: this.session.terminal.rows,
      },
      recording: {
        preset: this.session.recording.preset,
        fps: this.session.recording.fps,
        fontSize: this.session.recording.fontSize,
        fontFamily: this.session.recording.fontFamily,
      },
      stats: {
        events: this.eventCount,
        bytes: this.byteCount,
        transcriptBytes: this.transcriptBytes,
        durationMs: this.durationMs,
      },
    };
    await writeFile(join(this.dir, TTYLVAULT_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    return manifest;
  }
}

async function readRegistry(): Promise<VaultRegistryEntry[]> {
  try {
    const text = await readFile(join(vaultStoreDir(), INDEX_FILE), "utf8");
    return text
      .split(/\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as VaultRegistryEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function discoverVaultDirs(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(".ttylvault")).map((name) => join(resolve(dir), name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    const info = await stat(join(dir, TTYLVAULT_MANIFEST_FILE));
    return info.isFile();
  } catch {
    return false;
  }
}

function registryEntry(vaultDir: string, manifest: VaultManifest): VaultRegistryEntry {
  return {
    id: manifest.id,
    dir: resolve(vaultDir),
    createdAt: manifest.createdAt,
    command: manifest.command,
    outputVideo: manifest.outputVideo,
  };
}

function sanitizeTranscript(input: string): string {
  return input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[^\x09\x0a\x20-\x7e]/g, "");
}

function sanitizeName(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function newSessionId(): string {
  return createHash("sha256").update(randomBytes(32)).digest("base64url").slice(0, 18);
}
