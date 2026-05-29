# ttyl

`ttyl` lets you stream your terminal session as a URL, with read-only or fully interactive access.

## Features

- **Live Terminal Streaming**: Viewers can see terminal output in real time directly in their browser.
- **Interactive Access**: Support for both view-only and read-write sessions.
- **Session Management**: Built-in web dashboard and CLI console to manage connected viewers (kick clients, lock sessions).
- **Access Control**: Optional password protection for sessions.
- **Privacy by Design**: Control keys are passed via URL fragments and never logged. Sessions expire automatically and terminal output is never written to disk.
- **Flexible Deployment**: Run your own relay server via Node.js or deploy seamlessly to Cloudflare Workers.

---

## Installation

Install the CLI globally via npm:

```bash
npm install -g @rcx86/ttyl
```

This installs the `ttyl` executable, which provides the `stream`, `init`, `serve`, `admin`, and `links` commands.

---

## Relay Server Setup

A relay server is required to bridge the terminal broadcaster and the web viewers. You can deploy it using either of the following methods.

### Option A: Self-Hosted Node.js Server

Run the relay locally or on your own infrastructure:

```bash
ttyl serve                              # Listens on http://0.0.0.0:8080
ttyl serve --port 9000 --host 127.0.0.1 # Specify port and host
PORT=9000 HOST=127.0.0.1 ttyl serve     # Configure via environment variables
```

*Note: When deploying behind a reverse proxy handling TLS, set `TRUST_PROXY=1` so the rate-limiter accurately evaluates the `X-Forwarded-For` header.*

### Option B: Cloudflare Worker

Deploy the relay to Cloudflare's edge network (requires a Cloudflare account):

```bash
git clone https://github.com/rcx86/ttyl.git
cd ttyl
npm install
npx wrangler login
npm run deploy
```

This deploys the relay to a `*.workers.dev` subdomain (e.g., `https://ttyl-relay.<your-subdomain>.workers.dev`).

---

## Usage

### Initialization

Configure the CLI with your relay server URL. This saves the configuration to the user's configuration directory (e.g., `~/.config/ttyl/config.json`) so it doesn't need to be passed with every command.

```bash
ttyl init --server <relay-url>
```

### Starting a Session

Start broadcasting the current terminal session:

```bash
ttyl stream
```

By default, this generates three URLs:
- **Read-Write**: Grants viewers the ability to watch and type.
- **View-Only**: Grants viewers watch-only access.
- **Dashboard**: Owner-only interface for managing the session.

To create a strictly view-only session (where no interactive link is generated):

```bash
ttyl stream --view-only
```

### Session Lifetime

Sessions terminate immediately upon shell exit. They also enforce a maximum lifetime duration (default: 8 hours). To specify a custom lifetime:

```bash
ttyl stream --lifetime 2d       # Accepts formats like 30m, 6h, 8h, 2d, 1d12h
ttyl stream --lifetime never    # Disables automatic expiration
```

---

## Session Management & Security

`ttyl` sessions include an optional management layer for access control and administration.

### Dashboard & Admin Console

The `dashboard:` URL provides an interface to view connected clients, kick viewers, lock the session to prevent new joins, and manage passwords.

To access the management console from the CLI instead of the web:

```bash
ttyl admin '<dashboard-url>'
# or manually passing the components:
ttyl admin --id <id> --key <admin-key> --server <relay-url>
```

Available CLI commands within the admin console: `kick <#>`, `lock`, `unlock`, `password <value>`, `password clear`, `quit`.

### Password Protection

To require a password for all viewers (both view-only and read-write), initialize the stream with the `--password` flag. You will be prompted to enter the password interactively to prevent it from appearing in shell history:

```bash
ttyl stream --password
```

Passwords can also be set, updated, or removed dynamically via the dashboard or admin console. 

*Note: `ttyl` does not utilize user accounts. If a session password is forgotten, there is no email reset flow. Password recovery is performed by clearing or resetting the password via the authenticated dashboard or admin console.*

### Link Recovery

Stream URLs are printed only once upon startup. To retrieve active session links later, open a separate terminal on the same machine and run:

```bash
ttyl links
```

This queries the running session via a local IPC socket to reprint the URLs securely without writing secrets to disk.

---

## Configuration Reference

| Parameter | Configuration Method | Default |
| --- | --- | --- |
| Session lifetime (client) | `ttyl stream --lifetime <duration>` | Relay default |
| Session lifetime (server) | `SESSION_TTL_SECONDS` env var / `wrangler.toml` | 8 hours (28800) |
| Session password | `ttyl stream --password` or Dashboard | None |
| Dashboard / kick / lock | `dashboard:` link, or `ttyl admin <link>` | Per session |
| Sessions per IP | `ratelimits` in `wrangler.toml` (Worker) | 20 / minute |
| Server bind address | `--port`/`--host` flags or `PORT`/`HOST` env var | `0.0.0.0:8080` |
| Proxy trust | `TRUST_PROXY=1` env var | Off |
| Worker hostname | `name` in `wrangler.toml` | `ttyl-relay` |

---

## Development

```bash
npm run dev            # Run Cloudflare Worker locally
npm run dev:node       # Run Node server locally with auto-reload
npm test               # Run unit tests
npm run typecheck      # Type-check all targets

# Run end-to-end tests against a running relay:
node test/e2e.mjs http://127.0.0.1:8787
```