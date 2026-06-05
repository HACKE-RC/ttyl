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
  preset: string;
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
  preset: RecordPreset;
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
export const RECORD_PRESETS = {
  ttyl: {
    fps: DEFAULT_RECORD_FPS,
    fontSize: DEFAULT_RECORD_FONT_SIZE,
    fontFamily: DEFAULT_RECORD_FONT_FAMILY,
    paddingX: 6,
    paddingY: 4,
    theme: DEFAULT_RECORD_THEME,
  },
  presentation: {
    fps: 24,
    fontSize: 18,
    paddingX: 10,
    paddingY: 8,
    theme: DEFAULT_RECORD_THEME,
  },
  compact: {
    fps: 12,
    fontSize: 13,
    paddingX: 2,
    paddingY: 2,
    theme: DEFAULT_RECORD_THEME,
  },
  classic: {
    fps: 12,
    fontSize: 15,
    paddingX: 4,
    paddingY: 3,
    theme: {
      foreground: "#d4d4d4",
      background: "#000000",
      cursor: "#d4d4d4",
      ansi: [
        "#000000",
        "#cd3131",
        "#0dbc79",
        "#e5e510",
        "#2472c8",
        "#bc3fbc",
        "#11a8cd",
        "#e5e5e5",
        "#666666",
        "#f14c4c",
        "#23d18b",
        "#f5f543",
        "#3b8eea",
        "#d670d6",
        "#29b8db",
        "#ffffff",
      ],
    },
  },
} satisfies Record<string, ParsedRecordConfig>;
export type RecordPreset = keyof typeof RECORD_PRESETS;
export const DEFAULT_RECORD_PRESET: RecordPreset = "ttyl";

interface ParsedRecordThemeConfig {
  foreground?: string;
  background?: string;
  cursor?: string;
  ansi?: string[];
}

interface ParsedRecordConfig {
  preset?: RecordPreset;
  output?: string;
  size?: string;
  fps?: number;
  fontSize?: number;
  fontFamily?: string;
  cellWidth?: number;
  cellHeight?: number;
  paddingX?: number;
  paddingY?: number;
  theme?: ParsedRecordThemeConfig;
}

export function resolveRecordSettings(
  args: RecordCliArgs,
  config: Config,
  terminal: TerminalSizeSource,
): RecordSettings {
  const record = parseRecordConfig(config.record);
  const preset = args.preset
    ? readPresetName(args.preset, "--preset")
    : record.preset ?? DEFAULT_RECORD_PRESET;
  const presetConfig = RECORD_PRESETS[preset];
  const mergedRecord = mergeRecordConfig(presetConfig, record);
  const fallbackSize = {
    cols: DEFAULT_STREAM_COLS,
    rows: DEFAULT_STREAM_ROWS,
  };
  const configuredSize = mergedRecord.size;
  const sizeText = args.size || configuredSize || "";
  const size = sizeText ? parseTerminalSize(sizeText) ?? fallbackSize : terminalSizeFromTty(terminal, fallbackSize);
  const fontSize = args.fontSize
    ? readPositiveInt(args.fontSize, DEFAULT_RECORD_FONT_SIZE, "--font-size", 120)
    : mergedRecord.fontSize ?? DEFAULT_RECORD_FONT_SIZE;
  const cellWidth = readPositiveInt(
    mergedRecord.cellWidth,
    Math.max(1, Math.round(fontSize * 0.6)),
    "record.cellWidth",
    200,
  );
  const cellHeight = readPositiveInt(
    mergedRecord.cellHeight,
    Math.max(1, Math.round(fontSize * 1.2)),
    "record.cellHeight",
    200,
  );

  return {
    preset,
    output: args.output || mergedRecord.output || DEFAULT_RECORD_OUTPUT,
    size,
    fps: args.fps
      ? readPositiveInt(args.fps, DEFAULT_RECORD_FPS, "--fps", 120)
      : mergedRecord.fps ?? DEFAULT_RECORD_FPS,
    fontSize,
    cellWidth,
    cellHeight,
    fontFamily:
      args.fontFamily ||
      mergedRecord.fontFamily ||
      process.env.TTYL_RECORD_FONT?.trim() ||
      DEFAULT_RECORD_FONT_FAMILY,
    paddingX: readNonnegativeInt(mergedRecord.paddingX, 6, "record.paddingX", 200),
    paddingY: readNonnegativeInt(mergedRecord.paddingY, 4, "record.paddingY", 200),
    theme: resolveRecordTheme(mergedRecord.theme),
  };
}

function parseRecordConfig(input: unknown): ParsedRecordConfig {
  if (input === undefined) {
    return {};
  }
  if (!isObject(input)) {
    throw new Error("invalid record in config: expected an object");
  }
  return {
    preset: readOptionalPresetName(input.preset, "record.preset"),
    output: readOptionalString(input.output, "record.output"),
    size: readOptionalString(input.size, "record.size"),
    fps: readOptionalPositiveInt(input.fps, "record.fps", 120),
    fontSize: readOptionalPositiveInt(input.fontSize, "record.fontSize", 120),
    fontFamily: readOptionalString(input.fontFamily, "record.fontFamily"),
    cellWidth: readOptionalPositiveInt(input.cellWidth, "record.cellWidth", 200),
    cellHeight: readOptionalPositiveInt(input.cellHeight, "record.cellHeight", 200),
    paddingX: readOptionalNonnegativeInt(input.paddingX, "record.paddingX", 200),
    paddingY: readOptionalNonnegativeInt(input.paddingY, "record.paddingY", 200),
    theme: parseRecordThemeConfig(input.theme),
  };
}

function readOptionalPresetName(value: unknown, name: string): RecordPreset | undefined {
  const input = readOptionalString(value, name);
  return input ? readPresetName(input, name) : undefined;
}

function readPresetName(input: string, name: string): RecordPreset {
  const preset = input.trim() || DEFAULT_RECORD_PRESET;
  if (!(preset in RECORD_PRESETS)) {
    throw new Error(`invalid ${name} "${preset}": use one of ${Object.keys(RECORD_PRESETS).join(", ")}`);
  }
  return preset as RecordPreset;
}

function mergeRecordConfig(
  preset: ParsedRecordConfig,
  config: ParsedRecordConfig,
): ParsedRecordConfig {
  return {
    preset: config.preset ?? preset.preset,
    output: config.output ?? preset.output,
    size: config.size ?? preset.size,
    fps: config.fps ?? preset.fps,
    fontSize: config.fontSize ?? preset.fontSize,
    fontFamily: config.fontFamily ?? preset.fontFamily,
    cellWidth: config.cellWidth ?? preset.cellWidth,
    cellHeight: config.cellHeight ?? preset.cellHeight,
    paddingX: config.paddingX ?? preset.paddingX,
    paddingY: config.paddingY ?? preset.paddingY,
    theme: mergeThemeConfig(preset.theme, config.theme),
  };
}

function mergeThemeConfig(
  preset: ParsedRecordThemeConfig | undefined,
  config: ParsedRecordThemeConfig | undefined,
): ParsedRecordThemeConfig | undefined {
  if (preset === undefined) {
    return config;
  }
  if (config === undefined) {
    return preset;
  }
  return {
    foreground: config.foreground ?? preset.foreground,
    background: config.background ?? preset.background,
    cursor: config.cursor ?? preset.cursor,
    ansi: config.ansi ?? preset.ansi,
  };
}

function parseRecordThemeConfig(input: unknown): ParsedRecordThemeConfig | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!isObject(input)) {
    throw new Error("invalid record.theme in config: expected an object");
  }
  const ansiValue = input.ansi;
  let ansi: string[] | undefined;
  if (ansiValue !== undefined) {
    if (!Array.isArray(ansiValue) || ansiValue.length < 16) {
      throw new Error("invalid record.theme.ansi in config: expected at least 16 hex colors");
    }
    ansi = ansiValue.slice(0, 16).map((value, index) => readHexColor(value, `record.theme.ansi[${index}]`));
  }
  return {
    foreground: readOptionalHexColor(input.foreground, "record.theme.foreground"),
    background: readOptionalHexColor(input.background, "record.theme.background"),
    cursor: readOptionalHexColor(input.cursor, "record.theme.cursor"),
    ansi,
  };
}

function resolveRecordTheme(input: ParsedRecordThemeConfig | undefined): RecordTheme {
  if (input === undefined) {
    return DEFAULT_RECORD_THEME;
  }
  return {
    foreground: input.foreground ?? DEFAULT_RECORD_THEME.foreground,
    background: input.background ?? DEFAULT_RECORD_THEME.background,
    cursor: input.cursor ?? DEFAULT_RECORD_THEME.cursor,
    ansi: input.ansi ?? DEFAULT_RECORD_THEME.ansi,
  };
}

function readOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`invalid ${name} in config: expected a string`);
  }
  return value.trim() || undefined;
}

function readPositiveInt(value: unknown, fallback: number, name: string, max: number): number {
  return readOptionalPositiveInt(value, name, max) ?? fallback;
}

function readOptionalPositiveInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`invalid ${name}: expected a positive integer up to ${max}`);
  }
  return parsed;
}

function readNonnegativeInt(value: unknown, fallback: number, name: string, max: number): number {
  return readOptionalNonnegativeInt(value, name, max) ?? fallback;
}

function readOptionalNonnegativeInt(value: unknown, name: string, max: number): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`invalid ${name}: expected an integer from 0 to ${max}`);
  }
  return parsed;
}

function readOptionalHexColor(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`invalid ${name} in config: expected a #RRGGBB color`);
  }
  return value.toLowerCase();
}

function readHexColor(value: unknown, name: string): string {
  const color = readOptionalHexColor(value, name);
  if (color === undefined) {
    throw new Error(`invalid ${name} in config: expected a #RRGGBB color`);
  }
  return color;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
