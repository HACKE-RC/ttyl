export const TTYLVAULT_EVENTS_FILE = "events.jsonl";
export const TTYLVAULT_MANIFEST_FILE = "manifest.json";
export const TTYLVAULT_TRANSCRIPT_FILE = "transcript.txt";

export const VAULT_VIEW_PATH = /^\/v\/([^/]+)$/;
export const VAULT_API_ITEM_PATH = /^\/api\/vaults\/([^/]+)$/;
export const MAX_VAULT_UPLOAD_BYTES = 12 * 1024 * 1024;

export interface VaultManifest {
  schemaVersion: 1;
  format: "ttylvault";
  id: string;
  status: "running" | "finished" | "aborted";
  createdAt: string;
  finishedAt?: string;
  command: string[];
  cwd: string;
  outputVideo: string;
  exitCode?: number;
  files: {
    events: string;
    transcript: string;
  };
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
  stats: {
    events: number;
    bytes: number;
    transcriptBytes: number;
    durationMs: number;
  };
}

export type VaultEvent =
  | { type: "start"; time: string; elapsedMs: number }
  | { type: "resize"; time: string; elapsedMs: number; cols: number; rows: number }
  | { type: "data"; time: string; elapsedMs: number; encoding: "base64"; data: string }
  | { type: "exit"; time: string; elapsedMs: number; exitCode: number }
  | { type: "abort"; time: string; elapsedMs: number };

export interface VaultPayload {
  schemaVersion: 1;
  format: "ttylvault-share";
  manifest: VaultManifest;
  events: VaultEvent[];
  transcript: string;
}

export interface VaultCreateResponse {
  id: string;
  link: string;
  expiresAt: string | null;
}

export function validateVaultPayload(input: unknown): VaultPayload | null {
  if (!isObject(input)) {
    return null;
  }
  if (input.schemaVersion !== 1 || input.format !== "ttylvault-share") {
    return null;
  }
  const manifest = readManifest(input.manifest);
  if (!manifest) {
    return null;
  }
  if (!Array.isArray(input.events)) {
    return null;
  }
  const events = input.events.map(readEvent);
  if (events.some((event) => event === null)) {
    return null;
  }
  if (typeof input.transcript !== "string") {
    return null;
  }
  return {
    schemaVersion: 1,
    format: "ttylvault-share",
    manifest,
    events: events as VaultEvent[],
    transcript: input.transcript,
  };
}

export function vaultPayloadSize(payload: VaultPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
}

function readManifest(input: unknown): VaultManifest | null {
  if (!isObject(input)) {
    return null;
  }
  if (input.schemaVersion !== 1 || input.format !== "ttylvault") {
    return null;
  }
  if (
    typeof input.id !== "string" ||
    !["running", "finished", "aborted"].includes(String(input.status)) ||
    typeof input.createdAt !== "string" ||
    !Array.isArray(input.command) ||
    input.command.some((part) => typeof part !== "string") ||
    typeof input.cwd !== "string" ||
    typeof input.outputVideo !== "string"
  ) {
    return null;
  }
  const files = input.files;
  const terminal = input.terminal;
  const recording = input.recording;
  const stats = input.stats;
  if (!isObject(files) || typeof files.events !== "string" || typeof files.transcript !== "string") {
    return null;
  }
  if (!isObject(terminal) || !isNumber(terminal.cols) || !isNumber(terminal.rows)) {
    return null;
  }
  if (
    !isObject(recording) ||
    typeof recording.preset !== "string" ||
    !isNumber(recording.fps) ||
    !isNumber(recording.fontSize) ||
    typeof recording.fontFamily !== "string"
  ) {
    return null;
  }
  if (
    !isObject(stats) ||
    !isNumber(stats.events) ||
    !isNumber(stats.bytes) ||
    !isNumber(stats.transcriptBytes) ||
    !isNumber(stats.durationMs)
  ) {
    return null;
  }
  const manifest: VaultManifest = {
    schemaVersion: 1,
    format: "ttylvault",
    id: input.id,
    status: input.status as VaultManifest["status"],
    createdAt: input.createdAt,
    command: input.command,
    cwd: input.cwd,
    outputVideo: input.outputVideo,
    files: {
      events: files.events,
      transcript: files.transcript,
    },
    terminal: {
      cols: terminal.cols,
      rows: terminal.rows,
    },
    recording: {
      preset: recording.preset,
      fps: recording.fps,
      fontSize: recording.fontSize,
      fontFamily: recording.fontFamily,
    },
    stats: {
      events: stats.events,
      bytes: stats.bytes,
      transcriptBytes: stats.transcriptBytes,
      durationMs: stats.durationMs,
    },
  };
  if (typeof input.finishedAt === "string") {
    manifest.finishedAt = input.finishedAt;
  }
  if (isNumber(input.exitCode)) {
    manifest.exitCode = input.exitCode;
  }
  return manifest;
}

function readEvent(input: unknown): VaultEvent | null {
  if (!isObject(input) || typeof input.type !== "string" || typeof input.time !== "string" || !isNumber(input.elapsedMs)) {
    return null;
  }
  if (input.type === "start") {
    return { type: "start", time: input.time, elapsedMs: input.elapsedMs };
  }
  if (input.type === "resize" && isNumber(input.cols) && isNumber(input.rows)) {
    return { type: "resize", time: input.time, elapsedMs: input.elapsedMs, cols: input.cols, rows: input.rows };
  }
  if (input.type === "data" && input.encoding === "base64" && typeof input.data === "string") {
    return {
      type: "data",
      time: input.time,
      elapsedMs: input.elapsedMs,
      encoding: "base64",
      data: input.data,
    };
  }
  if (input.type === "exit" && isNumber(input.exitCode)) {
    return { type: "exit", time: input.time, elapsedMs: input.elapsedMs, exitCode: input.exitCode };
  }
  if (input.type === "abort") {
    return { type: "abort", time: input.time, elapsedMs: input.elapsedMs };
  }
  return null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
