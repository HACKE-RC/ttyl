import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
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
  removeVault,
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
  vault share <vault> [--server <url>] [--lifetime <30m|8h|2d|never>] [--private] [--json]
  vault rm <vault>
  vault revoke <share-link-or-id> [--server <url>] --admin-token <token>
  vault encrypt <vault> --output <file> --passphrase <passphrase>
  vault decrypt <file> --output <file|-> --passphrase <passphrase>
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
    case "rm":
      await rmCommand(rest);
      return;
    case "revoke":
      await revokeCommand(rest);
      return;
    case "encrypt":
      await encryptCommand(rest);
      return;
    case "decrypt":
      await decryptCommand(rest);
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
  const before = readContext(flagValue(args, "--before") ?? "60");
  const after = readContext(flagValue(args, "--after") ?? "60");
  const matches = [];
  for (const entry of await listVaults(dir)) {
    const transcript = await readVaultTranscript(entry.dir);
    const lower = transcript.toLowerCase();
    const needle = query.toLowerCase();
    let index = 0;
    while ((index = lower.indexOf(needle, index)) !== -1) {
      matches.push({
        id: entry.id,
        dir: entry.dir,
        createdAt: entry.createdAt,
        command: entry.command,
        offset: index,
        snippet: snippet(transcript, index, query.length, before, after),
      });
      index += Math.max(1, needle.length);
    }
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
  const privateShare = flagBool(args, "--private");
  const payload = await loadVaultPayload(await findVault(target));
  const size = vaultPayloadSize(payload);
  if (size > MAX_VAULT_UPLOAD_BYTES) {
    throw new Error(`vault upload is ${size} bytes; limit is ${MAX_VAULT_UPLOAD_BYTES}`);
  }
  const response = await uploadVault(server, ttl, payload, privateShare);
  if (flagBool(args, "--json")) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${response.link}\n`);
  process.stderr.write(`ttyl: admin token ${response.adminToken}\n`);
  if (response.expiresAt) {
    process.stderr.write(`ttyl: vault expires at ${response.expiresAt}\n`);
  }
}

async function rmCommand(args: string[]): Promise<void> {
  const target = positional(args);
  if (!target) {
    throw new Error("vault rm needs a vault id or path");
  }
  const dir = await removeVault(target);
  process.stderr.write(`ttyl: removed ${dir}\n`);
}

async function revokeCommand(args: string[]): Promise<void> {
  const target = positional(args);
  const adminToken = flagValue(args, "--admin-token") ?? adminTokenFromLink(target);
  if (!target || !adminToken) {
    throw new Error("vault revoke needs a share link/id and --admin-token");
  }
  const { server, id } = await remoteVaultTarget(target, flagValue(args, "--server") ?? "");
  const res = await fetch(`${server}/api/vaults/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) {
    throw new Error(`revoke vault: server returned ${res.status}`);
  }
  process.stderr.write(`ttyl: revoked ${id}\n`);
}

async function encryptCommand(args: string[]): Promise<void> {
  const target = positional(args);
  const output = flagValue(args, "--output") ?? "";
  const passphrase = flagValue(args, "--passphrase") ?? "";
  if (!target || !output || !passphrase) {
    throw new Error("vault encrypt needs a vault, --output, and --passphrase");
  }
  const payload = JSON.stringify(await loadVaultPayload(await findVault(target)));
  const encrypted = encryptText(payload, passphrase);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(encrypted, null, 2)}\n`, "utf8");
  process.stderr.write(`ttyl: encrypted ${output}\n`);
}

async function decryptCommand(args: string[]): Promise<void> {
  const target = positional(args);
  const output = flagValue(args, "--output") ?? "-";
  const passphrase = flagValue(args, "--passphrase") ?? "";
  if (!target || !passphrase) {
    throw new Error("vault decrypt needs a file and --passphrase");
  }
  const encrypted = JSON.parse(await readFile(target, "utf8")) as EncryptedVault;
  const plaintext = decryptText(encrypted, passphrase);
  if (output === "-") {
    process.stdout.write(`${JSON.stringify(JSON.parse(plaintext), null, 2)}\n`);
    return;
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(JSON.parse(plaintext), null, 2)}\n`, "utf8");
  process.stderr.write(`ttyl: decrypted ${output}\n`);
}

async function uploadVault(
  server: string,
  ttl: number | undefined,
  payload: VaultPayload,
  privateShare: boolean,
): Promise<VaultCreateResponse> {
  const url = new URL(`${server.replace(/\/+$/, "")}/api/vaults`);
  if (ttl !== undefined) {
    url.searchParams.set("ttl", String(ttl));
  }
  if (privateShare) {
    url.searchParams.set("private", "1");
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

async function remoteVaultTarget(target: string, serverFlag: string): Promise<{ server: string; id: string }> {
  try {
    const url = new URL(target);
    return { server: url.origin, id: url.pathname.split("/").filter(Boolean).pop() ?? "" };
  } catch {
    return { server: await resolveServer(serverFlag), id: target };
  }
}

function adminTokenFromLink(target: string): string {
  try {
    const hash = new URL(target).hash.replace(/^#/, "");
    return hash.startsWith("admin=") ? decodeURIComponent(hash.slice("admin=".length)) : "";
  } catch {
    return "";
  }
}

function positional(args: string[]): string {
  const valueFlags = new Set([
    "--dir",
    "--format",
    "--output",
    "--server",
    "--lifetime",
    "--speed",
    "--admin-token",
    "--before",
    "--after",
    "--passphrase",
  ]);
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

function readContext(input: string): number {
  const parsed = Number(input);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2000) {
    throw new Error("invalid context: expected an integer from 0 to 2000");
  }
  return parsed;
}

function snippet(text: string, index: number, length: number, before: number, after: number): string {
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + length + after);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

interface EncryptedVault {
  schemaVersion: 1;
  format: "ttylvault-encrypted";
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function encryptText(plaintext: string, passphrase: string): EncryptedVault {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    schemaVersion: 1,
    format: "ttylvault-encrypted",
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decryptText(input: EncryptedVault, passphrase: string): string {
  if (input.schemaVersion !== 1 || input.format !== "ttylvault-encrypted" || input.cipher !== "aes-256-gcm") {
    throw new Error("invalid encrypted vault");
  }
  const key = scryptSync(passphrase, Buffer.from(input.salt, "base64"), 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(input.data, "base64")), decipher.final()]).toString("utf8");
}

function delay(ms: number): Promise<void> {
  if (ms <= 1) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
