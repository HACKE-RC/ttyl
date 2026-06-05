# AGENTS.md

## Hard Rules

- Use `uv` for Python package management.
- Never add yourself as the author of any commit.
- Preserve user changes in a dirty worktree. Do not revert unrelated edits.
- Keep README changes concise. README is a quick project entrypoint, not full docs.

## Repo Model

- This is the `@rcx86/ttyl` npm package.
- The CLI entrypoint is `src/cli.ts`.
- Streaming client code lives under `src/client/stream.ts`.
- Browser viewer behavior lives in `web/viewer.client.txt`.
- Local recording code lives in `src/client/record*.ts`.
- Relay/server logic lives under `src/core` and `src/node`.

## Terminal Sizing

- The source side owns PTY size. Do not let browser viewport size resize the command.
- Browser-only behavior should be visual: scale, pan, fit, or 1:1 rendering.
- Avoid temporary sizing hacks that create blank space or couple browser size back to the PTY.
- If changing sizing, verify browser behavior with a real viewer or the viewport metric script, not just unit tests.

## Recording

- Local recording must not rely on a browser renderer or browser automation.
- Do not reintroduce temp SVG frame directories or unbounded promise/frame queues.
- Keep encoder backpressure bounded. Stream frames to ffmpeg or use another bounded pipeline.
- Keep boundaries separate:
  - `record.ts`: PTY/session orchestration only
  - `record-input.ts`: stdin/raw-mode handling
  - `record-renderer.ts`: terminal state to SVG
  - `record-encoder.ts`: ffmpeg/video encoding
- Config parsing should happen once at the boundary, then pass typed settings through the recorder.
- Presets should remain a closed typed set, not loose strings.
- When merging config over presets, only defined config values should override preset defaults.

## Release And npm

- This repo publishes to npm, not PyPI.
- Publishing is tag-driven through GitHub Actions trusted publishing.
- A package version bump alone does not publish. The pushed tag must match `package.json`.
- Before release work, check current package state with npm CLI commands instead of guessing.

## Validation

For normal TypeScript changes, run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

For recording changes, also run a built-CLI smoke and inspect the output:

```bash
node dist/cli.js record --preset compact --size 40x8 --output /tmp/ttyl-smoke.mp4 -- sh -c 'printf "ok\n"'
ffprobe -v error -show_entries stream=width,height -show_entries format=duration -of default=nw=1 /tmp/ttyl-smoke.mp4
```

For package/release changes, also run:

```bash
npm pack --dry-run --json
```

## Mistakes To Avoid

- Do not stop at a design explanation when the user asks to fix the issue.
- Do not install, publish, push, or commit unless explicitly asked.
- Do not let a broad review create cosmetic churn; fix structural problems first.
- Do not make a large god module when the feature has clear subprocess, rendering, encoding, and config boundaries.
- Do not use unbounded async chains for periodic work.
- Do not let `undefined` from parsed config wipe out preset defaults.
- Do not confuse tag-based publishing with automatic publishing on every version bump.
- Do not search outside the repo for instructions when repo-local context is enough.
