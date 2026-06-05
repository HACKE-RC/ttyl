import { describe, expect, it } from "vitest";
import { encodeSvgFramePacket, estimateSvgFramePacketSize } from "../src/client/record-encoder";
import type { RenderOptions } from "../src/client/record-renderer";
import {
  DEFAULT_RECORD_FONT_FAMILY,
  DEFAULT_RECORD_FONT_SIZE,
  DEFAULT_RECORD_PRESET,
  DEFAULT_RECORD_THEME,
} from "../src/client/record-settings";

const renderOptions: RenderOptions = {
  cols: 40,
  rows: 8,
  fontSize: DEFAULT_RECORD_FONT_SIZE,
  cellWidth: 8,
  cellHeight: 16,
  fontFamily: DEFAULT_RECORD_FONT_FAMILY,
  paddingX: 2,
  paddingY: 2,
  settings: {
    preset: DEFAULT_RECORD_PRESET,
    output: "demo.mp4",
    size: { cols: 40, rows: 8 },
    fps: 12,
    fontSize: DEFAULT_RECORD_FONT_SIZE,
    cellWidth: 8,
    cellHeight: 16,
    fontFamily: DEFAULT_RECORD_FONT_FAMILY,
    paddingX: 2,
    paddingY: 2,
    theme: DEFAULT_RECORD_THEME,
  },
};

describe("record encoder packets", () => {
  it("pads SVG frames to ffmpeg's fixed packet size", () => {
    const packet = encodeSvgFramePacket("<svg></svg>", 32);

    expect(packet).toHaveLength(32);
    expect(packet.subarray(0, 11).toString("utf8")).toBe("<svg></svg>");
  });

  it("rejects frames that exceed the packet budget", () => {
    expect(() => encodeSvgFramePacket("<svg></svg>", 4)).toThrow(/record frame exceeded ffmpeg packet size/);
  });

  it("sizes packets from the terminal grid", () => {
    expect(estimateSvgFramePacketSize(renderOptions)).toBeGreaterThanOrEqual(256 * 1024);
  });
});
