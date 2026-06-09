// `ttyl record` owns the local PTY session. ANSI/VT parsing is delegated to
// headless xterm, rendering to record-renderer, and video encoding to ffmpeg.
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { Terminal } from "@xterm/headless";
import { load } from "./config";
import { createVideoEncoder, estimateSvgFramePacketSize } from "./record-encoder";
import { attachLocalInput } from "./record-input";
import { createRenderOptions, renderTerminalSvg, terminalSvgSize } from "./record-renderer";
import { type RecordCliArgs, resolveRecordSettings } from "./record-settings";
import { createTtylVaultWriter, resolveTtylVaultSettings, type TtylVaultCliArgs } from "./ttylvault";

export type RecordArgs = RecordCliArgs & TtylVaultCliArgs;

export async function runRecord(args: RecordArgs): Promise<void> {
  const settings = resolveRecordSettings(args, await load(), process.stdout);
  const { size, fps } = settings;
  const command = args.command.length > 0 ? args.command : [process.env.SHELL || "/bin/sh"];
  const output = resolve(settings.output);
  const vaultSettings = resolveTtylVaultSettings(args, output);
  const vault = await createTtylVaultWriter(vaultSettings, {
    command,
    cwd: process.cwd(),
    outputVideo: output,
    terminal: settings.size,
    recording: {
      preset: settings.preset,
      fps: settings.fps,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      theme: settings.theme,
    },
  });
  const renderOptions = createRenderOptions(settings);
  const encoder = createVideoEncoder({
    output,
    fps,
    pixelSize: terminalSvgSize(renderOptions),
    framePacketSize: estimateSvgFramePacketSize(renderOptions),
  });
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

  let stopped = false;
  let exitCode = 0;
  let encoderFinished = false;
  let vaultFinished = false;
  let writeChain = Promise.resolve();
  let renderActive: Promise<void> | undefined;
  let renderQueued = false;
  let renderError: Error | undefined;

  const renderFrame = async (): Promise<void> => {
    await writeChain;
    await encoder.writeFrame(renderTerminalSvg(terminal, renderOptions));
  };

  const drainRenderQueue = async (): Promise<void> => {
    while (renderQueued && !stopped && !renderError) {
      renderQueued = false;
      await renderFrame();
    }
  };

  const requestFrame = (): void => {
    if (stopped || renderError) {
      return;
    }
    renderQueued = true;
    if (renderActive) {
      return;
    }
    renderActive = drainRenderQueue()
      .catch((err: unknown) => {
        renderError = err instanceof Error ? err : new Error(String(err));
        stop();
      })
      .finally(() => {
        renderActive = undefined;
        if (renderQueued && !stopped && !renderError) {
          requestFrame();
        }
      });
  };

  const waitForRenderIdle = async (): Promise<void> => {
    while (renderActive) {
      await renderActive;
    }
    if (renderError) {
      throw renderError;
    }
  };

  const interval = setInterval(requestFrame, 1000 / fps);
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
    vault.writeData(buf);
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    writeChain = writeChain.then(() => writeTerminal(terminal, bytes));
  });

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
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
    await waitForRenderIdle();
    await renderFrame();
    await encoder.finish();
    encoderFinished = true;
    await vault.finish(exitCode);
    vaultFinished = true;
    process.stderr.write(`ttyl: recorded ${output}\n`);
    if (vault.enabled) {
      process.stderr.write(`ttyl: vaulted ${vault.dir}\n`);
    }
    process.exitCode = exitCode;
  } finally {
    stopped = true;
    clearInterval(interval);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
    terminal.dispose();
    if (!encoderFinished) {
      encoder.abort();
    }
    if (!vaultFinished) {
      await vault.abort();
    }
  }
}

function writeTerminal(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  return new Promise((resolveWrite) => terminal.write(bytes, resolveWrite));
}
