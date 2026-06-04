import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORD_FPS,
  DEFAULT_RECORD_OUTPUT,
  DEFAULT_RECORD_THEME,
  resolveRecordSettings,
  type RecordCliArgs,
} from "../src/client/record-settings";

const emptyArgs: RecordCliArgs = {
  output: "",
  size: "",
  fps: "",
  fontSize: "",
  fontFamily: "",
  command: [],
};

describe("resolveRecordSettings", () => {
  it("uses terminal size and built-in defaults without config", () => {
    const settings = resolveRecordSettings(emptyArgs, {}, { isTTY: true, columns: 120, rows: 32 });

    expect(settings.output).toBe(DEFAULT_RECORD_OUTPUT);
    expect(settings.size).toEqual({ cols: 120, rows: 32 });
    expect(settings.fps).toBe(DEFAULT_RECORD_FPS);
    expect(settings.theme).toEqual(DEFAULT_RECORD_THEME);
  });

  it("uses record config as persistent defaults", () => {
    const settings = resolveRecordSettings(
      emptyArgs,
      {
        record: {
          output: "demo.webm",
          size: "100x30",
          fps: 24,
          fontSize: 16,
          fontFamily: "Test Mono",
          cellWidth: 11,
          cellHeight: 21,
          paddingX: 8,
          paddingY: 6,
          theme: {
            foreground: "#ffffff",
            background: "#000000",
            cursor: "#ff00ff",
          },
        },
      },
      { isTTY: true, columns: 120, rows: 32 },
    );

    expect(settings).toMatchObject({
      output: "demo.webm",
      size: { cols: 100, rows: 30 },
      fps: 24,
      fontSize: 16,
      fontFamily: "Test Mono",
      cellWidth: 11,
      cellHeight: 21,
      paddingX: 8,
      paddingY: 6,
      theme: {
        foreground: "#ffffff",
        background: "#000000",
        cursor: "#ff00ff",
      },
    });
    expect(settings.theme.ansi).toEqual(DEFAULT_RECORD_THEME.ansi);
  });

  it("lets CLI flags override configured defaults", () => {
    const settings = resolveRecordSettings(
      {
        ...emptyArgs,
        output: "cli.mp4",
        size: "90x20",
        fps: "30",
        fontSize: "18",
        fontFamily: "Cli Mono",
      },
      {
        record: {
          output: "config.mp4",
          size: "100x30",
          fps: 24,
          fontSize: 16,
          fontFamily: "Config Mono",
        },
      },
      { isTTY: true, columns: 120, rows: 32 },
    );

    expect(settings.output).toBe("cli.mp4");
    expect(settings.size).toEqual({ cols: 90, rows: 20 });
    expect(settings.fps).toBe(30);
    expect(settings.fontSize).toBe(18);
    expect(settings.fontFamily).toBe("Cli Mono");
  });

  it("accepts a configured 16-color ANSI palette", () => {
    const ansi = Array.from({ length: 16 }, (_, index) => `#${index.toString(16).repeat(6)}`);
    const settings = resolveRecordSettings(
      emptyArgs,
      { record: { theme: { ansi } } },
      { isTTY: true, columns: 120, rows: 32 },
    );

    expect(settings.theme.ansi).toEqual(ansi);
  });

  it("rejects invalid record config values", () => {
    expect(() => resolveRecordSettings(emptyArgs, { record: { fps: "fast" } }, {})).toThrow(/record\.fps/);
    expect(() => resolveRecordSettings(emptyArgs, { record: { theme: { background: "black" } } }, {})).toThrow(
      /record\.theme\.background/,
    );
    expect(() => resolveRecordSettings(emptyArgs, { record: { theme: { ansi: ["#000000"] } } }, {})).toThrow(
      /record\.theme\.ansi/,
    );
  });
});
