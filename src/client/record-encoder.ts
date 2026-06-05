import { spawn } from "node:child_process";
import { once } from "node:events";
import type { RenderOptions } from "./record-renderer";

export interface VideoEncoderOptions {
  output: string;
  fps: number;
  pixelSize: {
    width: number;
    height: number;
  };
  framePacketSize: number;
}

export interface VideoEncoder {
  writeFrame(svg: string): Promise<void>;
  finish(): Promise<void>;
  abort(): void;
}

export function createVideoEncoder(options: VideoEncoderOptions): VideoEncoder {
  const ext = options.output.toLowerCase().split(".").pop() ?? "";
  const args = [
    "-y",
    "-v",
    "error",
    "-f",
    "svg_pipe",
    "-frame_size",
    String(options.framePacketSize),
    "-video_size",
    `${options.pixelSize.width}x${options.pixelSize.height}`,
    "-framerate",
    String(options.fps),
    "-i",
    "pipe:0",
  ];
  if (ext === "mp4" || ext === "m4v" || ext === "mov") {
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  } else if (ext === "webm") {
    args.push("-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p");
  }
  args.push(options.output);

  const ffmpeg = spawn("ffmpeg", args, { stdio: ["pipe", "inherit", "pipe"] });
  const stdin = ffmpeg.stdin;
  if (!stdin) {
    throw new Error("ffmpeg stdin is unavailable");
  }

  let stderr = "";
  let stdinError: Error | undefined;
  let closeError: Error | undefined;
  let closed = false;
  let aborted = false;
  ffmpeg.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  stdin.on("error", (err: Error) => {
    stdinError = err;
  });

  const close = new Promise<void>((resolveClose) => {
    ffmpeg.on("error", (err) => {
      closed = true;
      closeError = new Error(`ffmpeg failed to start: ${err.message}`);
      resolveClose();
    });
    ffmpeg.on("close", (code) => {
      closed = true;
      if (aborted) {
        resolveClose();
      } else if (code === 0) {
        resolveClose();
      } else {
        closeError = new Error(`ffmpeg exited ${code}: ${stderr.trim() || "no stderr"}`);
        resolveClose();
      }
    });
  });

  const writeFrame = async (svg: string): Promise<void> => {
    if (closed || !stdin.writable) {
      throw stdinError ?? closeError ?? new Error("ffmpeg closed before accepting the next frame");
    }
    const packet = encodeSvgFramePacket(svg, options.framePacketSize);
    if (stdin.write(packet)) {
      return;
    }
    await Promise.race([once(stdin, "drain").then(() => undefined), close]);
    if (stdinError) {
      throw stdinError;
    }
    if (closeError) {
      throw closeError;
    }
  };

  const finish = async (): Promise<void> => {
    stdin.end();
    await close;
    if (closeError) {
      throw closeError;
    }
  };

  const abort = (): void => {
    aborted = true;
    if (!stdin.destroyed) {
      stdin.destroy();
    }
    if (!closed) {
      ffmpeg.kill();
    }
  };

  return { writeFrame, finish, abort };
}

export function estimateSvgFramePacketSize(options: RenderOptions): number {
  const minPacketSize = 256 * 1024;
  const perCellBudget = 384;
  const fixedBudget = 64 * 1024;
  return Math.max(minPacketSize, options.cols * options.rows * perCellBudget + fixedBudget);
}

export function encodeSvgFramePacket(svg: string, framePacketSize: number): Buffer {
  const frame = Buffer.from(svg, "utf8");
  if (frame.byteLength > framePacketSize) {
    throw new Error(
      `record frame exceeded ffmpeg packet size (${frame.byteLength} > ${framePacketSize} bytes); use a smaller --size`,
    );
  }
  const packet = Buffer.alloc(framePacketSize, 0x20);
  frame.copy(packet);
  return packet;
}
