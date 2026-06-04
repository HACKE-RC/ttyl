// `ttyl record` runs a local PTY and turns its terminal state into video frames
// without a browser. A headless xterm parser owns ANSI/VT interpretation; ffmpeg
// encodes the SVG frame sequence to MP4/WebM.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { Terminal } from "@xterm/headless";
import { load } from "./config";
import { type RecordCliArgs, type RecordSettings, resolveRecordSettings } from "./record-settings";

export type RecordArgs = RecordCliArgs;

interface RenderOptions {
  cols: number;
  rows: number;
  fontSize: number;
  cellWidth: number;
  cellHeight: number;
  fontFamily: string;
  paddingX: number;
  paddingY: number;
  settings: RecordSettings;
}

export async function runRecord(args: RecordArgs): Promise<void> {
  const settings = resolveRecordSettings(args, await load(), process.stdout);
  const { size, fps, fontSize } = settings;
  const command = args.command.length > 0 ? args.command : [process.env.SHELL || "/bin/sh"];
  const output = resolve(settings.output);
  const renderOptions: RenderOptions = {
    ...size,
    fontSize,
    cellWidth: settings.cellWidth,
    cellHeight: settings.cellHeight,
    fontFamily: settings.fontFamily,
    paddingX: settings.paddingX,
    paddingY: settings.paddingY,
    settings,
  };
  const frameDir = await mkdtemp(join(tmpdir(), "ttyl-record-"));
  const terminal = new Terminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: 0,
    allowProposedApi: true,
    theme: settings.theme,
    logLevel: "off",
  });

  const require = createRequire(import.meta.url);
  const pty = require("node-pty") as typeof import("node-pty");
  const child = pty.spawn(command[0], command.slice(1), {
    name: "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
    encoding: null,
  });

  let frame = 0;
  let closed = false;
  let exitCode = 0;
  let writeChain = Promise.resolve();
  let renderChain = Promise.resolve();
  const renderFrame = (): Promise<void> => {
    frame += 1;
    const path = join(frameDir, `frame-${String(frame).padStart(6, "0")}.svg`);
    return writeFile(path, renderTerminalSvg(terminal, renderOptions));
  };

  const interval = setInterval(() => {
    renderChain = renderChain.then(renderFrame, renderFrame);
  }, 1000 / fps);

  const restoreInput = attachLocalInput(child);
  const exit = new Promise<void>((resolveExit) => {
    child.onExit((ev) => {
      exitCode = ev.exitCode;
      resolveExit();
    });
  });
  child.onData((chunk: string | Buffer) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    process.stdout.write(buf);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    writeChain = writeChain.then(() => writeTerminal(terminal, bytes));
  });

  const stop = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(interval);
    restoreInput();
    try {
      child.kill();
    } catch {
      // ignore
    }
  };
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);

  try {
    await exit;
    clearInterval(interval);
    restoreInput();
    await writeChain;
    renderChain = renderChain.then(renderFrame, renderFrame);
    await renderChain;
    await encodeFrames(frameDir, fps, output);
    process.stderr.write(`ttyl: recorded ${output}\n`);
    process.exitCode = exitCode;
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
    terminal.dispose();
    await rm(frameDir, { recursive: true, force: true });
  }
}

function attachLocalInput(child: { write(data: string | Buffer): void }): () => void {
  const stdin = process.stdin;
  const isTty = Boolean(stdin.isTTY);
  const wasRaw = isTty ? stdin.isRaw : false;
  const onData = (buf: Buffer): void => child.write(buf);
  if (isTty) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on("data", onData);
  return () => {
    stdin.removeListener("data", onData);
    if (isTty) {
      stdin.setRawMode(wasRaw);
    }
    stdin.pause();
  };
}

function writeTerminal(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  return new Promise((resolveWrite) => terminal.write(bytes, resolveWrite));
}

function encodeFrames(frameDir: string, fps: number, output: string): Promise<void> {
  const ext = output.toLowerCase().split(".").pop() ?? "";
  const args = [
    "-y",
    "-v",
    "error",
    "-framerate",
    String(fps),
    "-i",
    join(frameDir, "frame-%06d.svg"),
  ];
  if (ext === "mp4" || ext === "m4v" || ext === "mov") {
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  } else if (ext === "webm") {
    args.push("-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p");
  }
  args.push(output);
  return new Promise((resolveEncode, reject) => {
    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    ffmpeg.on("error", (err) => reject(new Error(`ffmpeg failed to start: ${err.message}`)));
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolveEncode();
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim() || "no stderr"}`));
      }
    });
  });
}

function renderTerminalSvg(terminal: Terminal, options: RenderOptions): string {
  const width = even(options.cols * options.cellWidth + options.paddingX * 2);
  const height = even(options.rows * options.cellHeight + options.paddingY * 2);
  const buffer = terminal.buffer.active;
  const nullCell = buffer.getNullCell();
  const rows: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>text{white-space:pre;font-variant-ligatures:none;text-rendering:geometricPrecision}.cell-bg{shape-rendering:crispEdges}</style>`,
    `<rect width="100%" height="100%" fill="${options.settings.theme.background}"/>`,
  ];
  const textRows: string[] = [];
  const startY = buffer.baseY;
  for (let y = 0; y < options.rows; y++) {
    const line = buffer.getLine(startY + y);
    if (!line) {
      continue;
    }
    rows.push(renderBackgrounds(line, y, nullCell, options));
    textRows.push(renderText(line, y, nullCell, options));
  }
  rows.push(renderCursor(terminal, options));
  rows.push(...textRows);
  rows.push("</svg>");
  return rows.join("");
}

function renderBackgrounds(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  y: number,
  nullCell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>,
  options: RenderOptions,
): string {
  const rects: string[] = [];
  let runStart = -1;
  let runColor = "";
  for (let x = 0; x <= options.cols; x++) {
    const cell = x < options.cols ? line.getCell(x, nullCell) : undefined;
    const color = cell ? bgColor(cell, options) : "";
    if (color && runStart === -1) {
      runStart = x;
      runColor = color;
    } else if (runStart !== -1 && color !== runColor) {
      rects.push(
        `<rect class="cell-bg" x="${options.paddingX + runStart * options.cellWidth}" y="${options.paddingY + y * options.cellHeight}" width="${(x - runStart) * options.cellWidth}" height="${options.cellHeight}" fill="${runColor}"/>`,
      );
      runStart = color ? x : -1;
      runColor = color;
    }
  }
  return rects.join("");
}

function renderText(
  line: NonNullable<ReturnType<Terminal["buffer"]["active"]["getLine"]>>,
  y: number,
  nullCell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>,
  options: RenderOptions,
): string {
  const out: string[] = [];
  let run = "";
  let runStart = 0;
  let runCells = 0;
  let runStyle = "";
  for (let x = 0; x <= options.cols; x++) {
    const cell = x < options.cols ? line.getCell(x, nullCell) : undefined;
    const width = cell?.getWidth() ?? 0;
    const chars = cell && width > 0 && !cell.isInvisible() ? cell.getChars() || " " : "";
    const style = cell ? textStyle(cell, options) : "";
    if (!chars || (run && style !== runStyle)) {
      if (/\S/u.test(run)) {
        out.push(textElement(runStart, y, run, runStyle, runCells, options));
      }
      run = "";
      runCells = 0;
    }
    if (chars) {
      if (!run) {
        runStart = x;
        runStyle = style;
      }
      run += chars;
      runCells += width;
    }
  }
  return out.join("");
}

function renderCursor(terminal: Terminal, options: RenderOptions): string {
  const buffer = terminal.buffer.active;
  const x = buffer.cursorX;
  const y = buffer.cursorY;
  if (x < 0 || x >= options.cols || y < 0 || y >= options.rows) {
    return "";
  }
  const px = options.paddingX + x * options.cellWidth;
  const py = options.paddingY + y * options.cellHeight;
  return (
    `<rect class="cell-bg" x="${px}" y="${py}" width="${options.cellWidth}" height="${options.cellHeight}" fill="${options.settings.theme.cursor}" opacity="0.22"/>` +
    `<rect class="cell-bg" x="${px}" y="${py}" width="${options.cellWidth}" height="${options.cellHeight}" fill="none" stroke="${options.settings.theme.cursor}" stroke-width="1" opacity="0.85"/>`
  );
}

function textElement(
  x: number,
  y: number,
  text: string,
  style: string,
  cells: number,
  options: RenderOptions,
): string {
  const px = options.paddingX + x * options.cellWidth;
  const baseline =
    options.paddingY +
    y * options.cellHeight +
    Math.round((options.cellHeight - options.fontSize) / 2 + options.fontSize * 0.82);
  const textLength = Math.max(cells * options.cellWidth, options.cellWidth);
  return `<text x="${px}" y="${baseline}" ${style} font-family="${escapeXml(options.fontFamily)}" font-size="${options.fontSize}" dominant-baseline="alphabetic" xml:space="preserve" textLength="${textLength}" lengthAdjust="spacingAndGlyphs">${escapeXml(text)}</text>`;
}

function textStyle(cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>, options: RenderOptions): string {
  const weight = cell.isBold() ? " font-weight=\"700\"" : "";
  const style = cell.isItalic() ? " font-style=\"italic\"" : "";
  const decorations = [
    cell.isUnderline() ? "underline" : "",
    cell.isStrikethrough() ? "line-through" : "",
    cell.isOverline() ? "overline" : "",
  ].filter(Boolean);
  const decoration = decorations.length > 0 ? ` text-decoration="${decorations.join(" ")}"` : "";
  return `fill="${fgColor(cell, options.settings)}"${weight}${style}${decoration}`;
}

function fgColor(cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>, settings: RecordSettings): string {
  if (cell.isInverse()) {
    return baseBgColor(cell, settings) || settings.theme.background;
  }
  return baseFgColor(cell, settings);
}

function baseFgColor(cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>, settings: RecordSettings): string {
  if (cell.isFgRGB()) {
    return maybeDim(cell, hex24(cell.getFgColor()));
  }
  if (cell.isFgPalette()) {
    const color = cell.getFgColor();
    return maybeDim(cell, paletteColor(cell.isBold() && color < 8 ? color + 8 : color, settings));
  }
  return cell.isDim() ? dimColor(settings.theme.foreground) : settings.theme.foreground;
}

function bgColor(cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>, options: RenderOptions): string {
  if (cell.isInverse()) {
    return baseFgColor(cell, options.settings);
  }
  return baseBgColor(cell, options.settings);
}

function baseBgColor(cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>, settings: RecordSettings): string {
  if (cell.isBgRGB()) {
    return hex24(cell.getBgColor());
  }
  if (cell.isBgPalette()) {
    return paletteColor(cell.getBgColor(), settings);
  }
  return "";
}

function paletteColor(index: number, settings: RecordSettings): string {
  if (index < settings.theme.ansi.length) {
    return settings.theme.ansi[index] ?? settings.theme.foreground;
  }
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    return rgbHex(cube(r), cube(g), cube(b));
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10;
    return rgbHex(v, v, v);
  }
  return settings.theme.foreground;
}

function cube(value: number): number {
  return value === 0 ? 0 : 55 + value * 40;
}

function hex24(value: number): string {
  return rgbHex((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

function rgbHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function maybeDim(cell: ReturnType<Terminal["buffer"]["active"]["getNullCell"]>, color: string): string {
  return cell.isDim() ? dimColor(color) : color;
}

function dimColor(color: string): string {
  const r = Number.parseInt(color.slice(1, 3), 16);
  const g = Number.parseInt(color.slice(3, 5), 16);
  const b = Number.parseInt(color.slice(5, 7), 16);
  return rgbHex(Math.round(r * 0.55), Math.round(g * 0.55), Math.round(b * 0.55));
}

function even(value: number): number {
  return value % 2 === 0 ? value : value + 1;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
