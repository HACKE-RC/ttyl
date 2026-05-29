# ttyl

`ttyl` streams a live, interactive terminal session through a self-hosted relay server and exposes it as a shareable browser link. Viewers see terminal output in real time and can type into the same PTY-backed session.

It is effectively a live, bidirectional terminal share: one broadcaster owns the terminal, and connected viewers mirror its output and can send input back into the session.

## Features

- Stream your current shell or a specific command through a PTY
- Self-hosted HTTP/WebSocket relay server
- Browser viewer powered by xterm.js
- Shared-input sessions: connected viewers can type into the terminal
- Scrollback replay for late joiners
- Automatic terminal resize propagation from broadcaster to viewers
- Embedded web assets with no frontend build step

## Architecture

```text
local terminal + PTY
        |
        v
ttyl stream  --WebSocket-->  ttyl serve  --WebSocket-->  browser viewers
```

The flow is split into two commands:

- `ttyl serve` starts the relay server, exposes the browser UI, creates session IDs, and bridges broadcaster/viewer sockets.
- `ttyl stream` creates a remote session, starts a local PTY, mirrors PTY output to your own terminal, and streams terminal frames to the relay.

At runtime:

1. The streaming client creates a session with `POST /api/sessions`.
2. The client opens a broadcaster WebSocket and sends output and resize frames.
3. Viewers open `/s/<id>` and connect to a viewer WebSocket.
4. The server fans terminal output to all viewers and forwards viewer keystrokes back to the broadcaster PTY.
5. The broadcaster owns terminal dimensions; viewers only mirror resize events.

## Requirements

- Go 1.26.2 or newer
- A terminal environment that supports PTYs
- A browser with WebSocket support for viewers

## Build

```bash
go build -o ttyl ./cmd/ttyl
```

## Commands

### Start the relay server

```bash
./ttyl serve -addr :8080
```

This starts the HTTP/WebSocket relay server and serves:

- `POST /api/sessions` to create a session ID
- `GET /s/{id}` for the viewer page
- `GET /ws/{id}/broadcast` for the broadcaster socket
- `GET /ws/{id}/view` for viewer sockets

### Stream your shell

```bash
./ttyl stream -server http://localhost:8080
```

When the session is created, the client prints a shareable URL like:

```text
http://localhost:8080/s/<session-id>
```

Anyone with that URL can open the session in a browser and interact with the shared terminal.

### Stream a specific command

```bash
./ttyl stream -server http://localhost:8080 -- bash --norc -i
```

If no command is provided, `ttyl` uses `$SHELL`, falling back to `/bin/sh` when unset.

The session ends when the wrapped command exits or the broadcaster disconnects.

## Example workflow

1. Start the relay server on your machine or a remote host.
2. Run `ttyl stream -server <server-url>` from the terminal you want to share.
3. Copy the printed `/s/<id>` URL.
4. Open the link in one or more browsers.
5. All viewers see the same terminal, and any viewer can type into it.

## Browser viewer

The viewer page is embedded into the Go binary and loads xterm.js from a CDN, so there is no separate frontend build process.

Viewer behavior:

- reconnects automatically if the WebSocket drops
- mirrors terminal resize events from the broadcaster
- forwards browser keystrokes back to the shared session
- shows connection state in the page header

## Security model

Session access is capability-based:

- the session ID is an unguessable random token
- anyone who has the session URL can both view and type
- there is currently no view-only mode
- WebSocket origin checks are intentionally permissive because the session URL itself is treated as the capability

For remote use, run the relay behind TLS. The client automatically switches from `ws://` to `wss://` when the configured server URL uses `https://`.

Only share links with people you trust, because all participants can inject terminal input.

## Project layout

| Path | Responsibility |
| --- | --- |
| `cmd/ttyl` | CLI entrypoint for `serve` and `stream` |
| `internal/client` | PTY lifecycle, local terminal handling, and stream orchestration |
| `internal/server` | HTTP routes, WebSocket upgrade, and relay plumbing |
| `internal/session` | Session hub, subscriptions, fan-in/fan-out, and scrollback |
| `internal/wire` | Binary frame protocol shared by client and server |
| `web` | Embedded viewer HTML/JS assets |

## Test

```bash
go test ./...
```

## Notes

- The broadcaster's local terminal is put into raw mode while the stream is active.
- The broadcaster continues to use the terminal locally while output is mirrored remotely.
- Late joiners receive buffered terminal output so they do not start from a blank screen.
