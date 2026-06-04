import type { Config } from "./config";
import {
  DEFAULT_STREAM_COLS,
  DEFAULT_STREAM_ROWS,
  type TerminalSize,
  type TerminalSizeSource,
  parseTerminalSize,
  terminalSizeFromTty,
} from "./util";

export interface RecordCliArgs {
  output: string;
  size: string;
  fps: string;
  fontSize: string;
  fontFamily: string;
  command: string[];
}

export interface RecordTheme {
  foreground: string;
  background: string;
  cursor: string;
  ansi: string[];
}

export interface RecordSettings {
  output: string;
  size: TerminalSize;
  fps: number;
  fontSize: number;
  cellWidth: number;
  cellHeight: number;
  fontFamily: string;
  paddingX: number;
  paddingY: number;
  theme: RecordTheme;
}

export const DEFAULT_RECORD_OUTPUT = "ttyl-recording.mp4";
export const DEFAULT_RECORD_FPS = 12;
export const DEFAULT_RECORD_FONT_SIZE = 15;
export const DEFAULT_RECORD_FONT_FAMILY =
  "'JetBrains Mono', 'Symbols Nerd Font Mono', 'JetBrainsMono Nerd Font', 'JetBrainsMonoNL Nerd Font', 'Symbols Nerd Font', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const DEFAULT_RECORD_THEME: RecordTheme = {
  foreground: "#c8d3f5",
  background: "#0b0e14",
  cursor: "#c8d3f5",
  ansi: [
    "#15161e",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#a9b1d6",
    "#414868",
    "#ff899d",
    "#9fe044",
    "#faba4a",
    "#8db0ff",
    "#c7a9ff",
    "#a4daff",
    "#c0caf5",
  ],
};

export function resolveRecordSettings(
  args: RecordCliArgs,
  config: Config,
  terminal: TerminalSizeSource,
): RecordSettings {
  const record = readRecordConfig(config.record);
  const fallbackSize = {
    cols: DEFAULT_STREAM_COLS,
    rows: DEFAULT_STREAM_ROWS,
  };
  const configuredSize = readString(record.size, "record.size");
  const sizeText = args.size || configuredSize || "";
  const size = sizeText ? parseTerminalSize(sizeText) ?? fallbackSize : terminalSizeFromTty(terminal, fallbackSize);
  const fontSize = args.fontSize
    ? readPositiveInt(args.fontSize, DEFAULT_RECORD_FONT_SIZE, "--font-size", 120)
    : readPositiveInt(record.fontSize, DEFAULT_RECORD_FONT_SIZE, "record.fontSize", 120);
  const cellWidth = readPositiveInt(record.cellWidth, Math.max(1, Math.round(fontSize * 0.6)), "record.cellWidth", 200);
  const cellHeight = readPositiveInt(
    record.cellHeight,
    Math.max(1, Math.round(fontSize * 1.2)),
    "record.cellHeight",
    200,
  );

  return {
    output: args.output || readString(record.output, "record.output") || DEFAULT_RECORD_OUTPUT,
    size,
    fps: args.fps
      ? readPositiveInt(args.fps, DEFAULT_RECORD_FPS, "--fps", 120)
      : readPositiveInt(record.fps, DEFAULT_RECORD_FPS, "record.fps", 120),
    fontSize,
    cellWidth,
    cellHeight,
    fontFamily:
      args.fontFamily ||
      readString(record.fontFamily, "record.fontFamily") ||
      process.env.TTYL_RECORD_FONT?.trim() ||
      DEFAULT_RECORD_FONT_FAMILY,
    paddingX: readNonnegativeInt(record.paddingX, 6, "record.paddingX", 200),
    paddingY: readNonnegativeInt(record.paddingY, 4, "record.paddingY", 200),
    theme: resolveRecordTheme(record.theme),
  };
}

function readRecordConfig(input: unknown): NonNullable<Config["record"]> {
  if (input === undefined) {
    return {};
  }
  if (!isObject(input)) {
    throw new Error("invalid record in config: expected an object");
  }
  return input;
}

function resolveRecordTheme(input: unknown): RecordTheme {
  if (input === undefined) {
    return DEFAULT_RECORD_THEME;
  }
  if (!isObject(input)) {
    throw new Error("invalid record.theme in config: expected an object");
  }
  const ansiValue = input.ansi;
  let ansi = DEFAULT_RECORD_THEME.ansi;
  if (ansiValue !== undefined) {
    if (!Array.isArray(ansiValue) || ansiValue.length < 16) {
      throw new Error("invalid record.theme.ansi in config: expected at least 16 hex colors");
    }
    ansi = ansiValue.slice(0, 16).map((value, index) => readHexColor(value, `record.theme.ansi[${index}]`));
  }
  return {
    foreground: readHexColor(input.foreground, "record.theme.foreground", DEFAULT_RECORD_THEME.foreground),
    background: readHexColor(input.background, "record.theme.background", DEFAULT_RECORD_THEME.background),
    cursor: readHexColor(input.cursor, "record.theme.cursor", DEFAULT_RECORD_THEME.cursor),
    ansi,
  };
}

function readString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid ${name} in config: expected a string`);
  }
  return value.trim() || undefined;
}

function readPositiveInt(value: unknown, fallback: number, name: string, max: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`invalid ${name} in config: expected a positive integer up to ${max}`);
  }
  return parsed;
}

function readNonnegativeInt(value: unknown, fallback: number, name: string, max: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`invalid ${name} in config: expected an integer from 0 to ${max}`);
  }
  return parsed;
}

function readHexColor(value: unknown, name: string, fallback?: string): string {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`invalid ${name} in config: expected a #RRGGBB color`);
  }
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`invalid ${name} in config: expected a #RRGGBB color`);
  }
  return value.toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
