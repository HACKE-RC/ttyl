import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseLifetime, resolveServer } from "./util";
import {
  eventsToAsciicast,
  findVault,
  listVaults,
  loadVaultPayload,
  readVaultEvents,
  readVaultManifest,
  readVaultTranscript,
  vaultStoreDir,
} from "./ttylvault";
import {
  MAX_VAULT_UPLOAD_BYTES,
  vaultPayloadSize,
  type VaultCreateResponse,
  type VaultPayload,
} from "../core/vault";
import { flagBool, flagValue } from "../args";

const VAULT_USAGE = `ttyl vault - inspect, replay, export, and share ttylvault archives

Commands:
  vault list [--dir <dir>] [--json]
  vault info <vault> [--json]
  vault search <query> [--dir <dir>] [--json]
  vault replay <vault> [--speed <n>] [--no-timing]
  vault export <vault> --format <text|asciicast|json> [--output <file|-]
  vault share <vault> [--server <url>] [--lifetime <30m|8h|2d|never>] [--json]
`;

export async function runTtylVaultCli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "list":
      await listCommand(rest);
      return;
    case "info":
      await infoCommand(rest);
      return;
    case "search":
      await searchCommand(rest);
      return;
    case "replay":
      await replayCommand(rest);
      return;
    case "export":
      await exportCommand(rest);
      return;
    case "share":
      await shareCommand(rest);
      return;
    case "help":
    case "-h":
    case "--help":
    case undefined:
      process.stdout.write(VAULT_USAGE);
      return;
    default:
      throw new Error(`unknown vault command "${cmd}"`);
  }
}

async function listCommand(args: string[]): Promise<void> {
  const dir = flagValue(args, "--dir") ?? vaultStoreDir();
  const entries = await listVaults(dir);
  if (flagBool(args, "--json")) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    process.stdout.write("no vaults found\n");
    return;
  }
  for (const entry of entries) {
    process.stdout.write(
      `${entry.id}\t${entry.createdAt}\t${entry.command.join(" ")}\t${entry.dir}\n`,
    );
  }
}

async function infoCommand(args: string[]): Promise<void> {
  const target = positional(args);
  if (!target) {
    throw new Error("vault info needs a vault id or path");
  }
  const dir = await findVault(target);
  const manifest = await readVaultManifest(dir);
  if (flagBool(args, "--json")) {
    process.stdout.write(`${JSON.stringify({ dir, manifest }, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `id: ${manifest.id}`,
      `dir: ${dir}`,
      `status: ${manifest.status}`,
      `created: ${manifest.createdAt}`,
      `finished: ${manifest.finishedAt ?? ""}`,
      `exit: ${manifest.exitCode ?? ""}`,
      `command: ${manifest.command.join(" ")}`,
      `video: ${manifest.outputVideo}`,
      `size: ${manifest.terminal.cols}x${manifest.terminal.rows}`,
      `events: ${manifest.stats.events}`,
      `bytes: ${manifest.stats.bytes}`,
      `duration_ms: ${manifest.stats.durationMs}`,
    ].join("\n") + "\n",
  );
}

async function searchCommand(args: string[]): Promise<void> {
  const query = positional(args);
  if (!query) {
    throw new Error("vault search needs a query");
  }
  const dir = flagValue(args, "--dir") ?? vaultStoreDir();
  const matches = [];
  for (const entry of await listVaults(dir)) {
    const transcript = await readVaultTranscript(entry.dir);
    const index = transcript.toLowerCase().indexOf(query.toLowerCase());
    if (index === -1) {
      continue;
    }
    matches.push({
      id: entry.id,
      dir: entry.dir,
      createdAt: entry.createdAt,
      command: entry.command,
      snippet: snippet(transcript, index, query.length),
    });
  }
  if (flagBool(args, "--json")) {
    process.stdout.write(`${JSON.stringify(matches, null, 2)}\n`);
    return;
  }
  for (const match of matches) {
    process.stdout.write(`${match.id}\t${match.createdAt}\t${match.snippet}\t${match.dir}\n`);
  }
}

async function replayCommand(args: string[]): Promise<void> {
  const target = positional(args);
  if (!target) {
    throw new Error("vault replay needs a vault id or path");
  }
  const speed = readSpeed(flagValue(args, "--speed") ?? "1");
  const timed = !flagBool(args, "--no-timing");
  const events = await readVaultEvents(await findVault(target));
  let last = 0;
  for (const event of events) {
    if (timed) {
      const waitMs = Math.max(0, event.elapsedMs - last) / speed;
      await delay(waitMs);
      last = event.elapsedMs;
    }
    if (event.type === "data") {
      process.stdout.write(Buffer.from(event.data, "base64"));
    }
  }
}

async function exportCommand(args: string[]): Promise<void> {
  const target = positional(args);
  if (!target) {
    throw new Error("vault export needs a vault id or path");
  }
  const format = flagValue(args, "--format") ?? "text";
  const dir = await findVault(target);
  const manifest = await readVaultManifest(dir);
  const events = await readVaultEvents(dir);
  let body: string;
  switch (format) {
    case "text":
      body = await readVaultTranscript(dir);
      break;
    case "asciicast":
      body = eventsToAsciicast(manifest, events);
      break;
    case "json":
      body = `${JSON.stringify(await loadVaultPayload(dir), null, 2)}\n`;
      break;
    default:
      throw new Error("invalid --format: use text, asciicast, or json");
  }
  const output = flagValue(args, "--output") ?? "-";
  if (output === "-") {
    process.stdout.write(body);
    return;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, body, "utf8");
  process.stderr.write(`ttyl: exported ${output}\n`);
}

async function shareCommand(args: string[]): Promise<void> {
  const target = positional(args);
  if (!target) {
    throw new Error("vault share needs a vault id or path");
  }
  const server = await resolveServer(flagValue(args, "--server") ?? "");
  const ttl = parseLifetime(flagValue(args, "--lifetime") ?? "");
  const payload = await loadVaultPayload(await findVault(target));
  const size = vaultPayloadSize(payload);
  if (size > MAX_VAULT_UPLOAD_BYTES) {
    throw new Error(`vault upload is ${size} bytes; limit is ${MAX_VAULT_UPLOAD_BYTES}`);
  }
  const response = await uploadVault(server, ttl, payload);
  if (flagBool(args, "--json")) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${response.link}\n`);
  if (response.expiresAt) {
    process.stderr.write(`ttyl: vault expires at ${response.expiresAt}\n`);
  }
}

async function uploadVault(
  server: string,
  ttl: number | undefined,
  payload: VaultPayload,
): Promise<VaultCreateResponse> {
  const url = new URL(`${server.replace(/\/+$/, "")}/api/vaults`);
  if (ttl !== undefined) {
    url.searchParams.set("ttl", String(ttl));
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`share vault: server returned ${res.status}`);
  }
  const body = (await res.json()) as VaultCreateResponse;
  if (!body.link) {
    throw new Error("share vault: server returned no link");
  }
  return body;
}

function positional(args: string[]): string {
  const valueFlags = new Set(["--dir", "--format", "--output", "--server", "--lifetime", "--speed"]);
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

function readSpeed(input: string): number {
  const speed = Number(input);
  if (!Number.isFinite(speed) || speed <= 0 || speed > 100) {
    throw new Error("invalid --speed: expected a number from 0.01 to 100");
  }
  return speed;
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function delay(ms: number): Promise<void> {
  if (ms <= 1) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
