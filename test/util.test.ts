import { describe, expect, it } from "vitest";
import {
  DEFAULT_STREAM_COLS,
  DEFAULT_STREAM_ROWS,
  parseTerminalSize,
} from "../src/client/util";

describe("parseTerminalSize", () => {
  it("returns undefined for an empty value", () => {
    expect(parseTerminalSize("")).toBeUndefined();
  });

  it("parses cols x rows", () => {
    expect(parseTerminalSize("80x24")).toEqual({ cols: 80, rows: 24 });
    expect(parseTerminalSize("100X30")).toEqual({ cols: 100, rows: 30 });
  });

  it("rejects malformed sizes", () => {
    expect(() => parseTerminalSize("80")).toThrow(/invalid --size/);
    expect(() => parseTerminalSize("wide")).toThrow(/invalid --size/);
  });

  it("rejects implausibly small sizes", () => {
    expect(() => parseTerminalSize("19x24")).toThrow(/minimum size is 20x5/);
    expect(() => parseTerminalSize("80x4")).toThrow(/minimum size is 20x5/);
  });

  it("exposes the fixed default stream size", () => {
    expect({ cols: DEFAULT_STREAM_COLS, rows: DEFAULT_STREAM_ROWS }).toEqual({ cols: 80, rows: 24 });
  });
});
