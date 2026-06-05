# ttyl

Share a terminal as a browser URL, or record a local terminal command to MP4/WebM.

`ttyl` gives you:

- live terminal streaming with read-only and read-write links
- a browser viewer that keeps the source terminal grid stable
- a small dashboard/admin console for managing viewers
- optional password protection
- local terminal recording without browser automation
- self-hosted Node relay or Cloudflare Worker deployment

## Install

```bash
npm install -g @rcx86/ttyl
```

This installs the `ttyl` CLI.

## Quick Start

Run a local relay:

```bash
ttyl serve
```

In another terminal, save that relay as your default:

```bash
ttyl init --server http://localhost:8080
```

Start sharing your terminal:

```bash
ttyl stream
```

`ttyl stream` prints:

- a read-write URL
- a view-only URL
- a dashboard URL

## Streaming

Start a normal interactive stream:

```bash
ttyl stream
```

Start a view-only stream:

```bash
ttyl stream --view-only
```

Add a password prompt:

```bash
ttyl stream --password
```

Pin the terminal grid instead of following your local terminal size:

```bash
ttyl stream --size 100x30
```

By default, the source terminal owns the PTY size. Browser viewers do not resize
the command; they can switch between readable, fit, and 1:1 viewing modes.

If you lose the URLs, print active session links from another terminal:

```bash
ttyl links
```

Stop a running stream:

```bash
ttyl stop
ttyl stop <session-id>
```

## Recording

Record a local command to MP4:

```bash
ttyl record --output demo.mp4 -- npm test
```

Record a shell session:

```bash
ttyl record --output demo.mp4 -- bash
```

Use a built-in preset:

```bash
ttyl record --preset presentation --output demo.mp4 -- npm test
```

Available presets:

- `ttyl`: default ttyl viewer style
- `presentation`: larger text and higher FPS
- `compact`: smaller output
- `classic`: plain black terminal style

Recording uses your current terminal size by default. Pin the recorded grid when
you need stable dimensions:

```bash
ttyl record --preset presentation --size 100x30 --output demo.mp4 -- npm test
```

Useful recording flags:

```bash
ttyl record --preset compact --fps 24 --font-size 14 --output demo.webm -- bash
ttyl record --font-family "JetBrains Mono" --output demo.mp4 -- npm test
```

MP4 output uses `ffmpeg` with H.264. WebM output uses VP9.

## Relay Deployment

Run the relay with Node:

```bash
ttyl serve
ttyl serve --port 9000 --host 127.0.0.1
PORT=9000 HOST=127.0.0.1 ttyl serve
```

Deploy the relay to Cloudflare Workers:

```bash
git clone https://github.com/rcx86/ttyl.git
cd ttyl
npm install
npx wrangler login
npm run deploy
```

When running behind a TLS reverse proxy, set `TRUST_PROXY=1` so rate limiting
uses `X-Forwarded-For` correctly.

## Config

`ttyl init --server <url>` writes the default relay URL to:

```text
~/.config/ttyl/config.json
```

You can also set recording defaults there:

```json
{
  "server": "http://localhost:8080",
  "record": {
    "preset": "presentation",
    "output": "demo.mp4",
    "size": "100x30",
    "fps": 24,
    "fontSize": 15,
    "fontFamily": "JetBrains Mono"
  }
}
```

Command-line flags override config values for that run.

## Admin

Open the dashboard URL in a browser, or use the CLI admin console:

```bash
ttyl admin '<dashboard-url>'
```

Admin commands include `kick`, `lock`, `unlock`, `password`, `password clear`,
and `quit`.

## Development

```bash
npm install
npm run dev            # Cloudflare Worker dev server
npm run dev:node       # Node relay with auto-reload
npm test
npm run typecheck
```

Run end-to-end tests against a running relay:

```bash
node test/e2e.mjs http://127.0.0.1:8787
```

## Release

npm publishing is tag-driven. Bump `package.json`, commit the change, then push
a matching tag:

```bash
git tag v0.1.5
git push origin HEAD v0.1.5
```

The GitHub workflow checks that the tag matches `package.json` before publishing
to npm. A version bump without the tag does not publish.
