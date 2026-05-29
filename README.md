# ttyl

Share your terminal with a link.

`ttyl` lets you stream your terminal session as a URL, with read-only or full access.

What you get:

- Viewers see output live and can type into the session.
- Two link types: a view-only link for people who should just watch, and a
  read-write link for people who should be able to drive.
- Deploy it free to Cloudflare with one command, or run it as a plain server on
  your own machine.
- Links are unguessable, the control key never ends up in a URL or a log,
  sessions expire on their own, and nothing is ever written to disk.

---

## Quick start

### 1. Install the CLI

```bash
npm install -g @rcx86/ttyl
```

That gives you the `ttyl` command (`stream`, `init`, and `serve`).

### 2. Put up a relay

You need a relay for viewers to connect to. Pick one; they behave the same.

The simplest is to run one yourself with the CLI you just installed:

```bash
ttyl serve          # listens on http://0.0.0.0:8080
```

Put that behind HTTPS (Caddy or nginx is fine) so links work over `wss://`.

Prefer something with nothing to maintain? Deploy the relay free to Cloudflare
(clone this repo, then):

```bash
npm install
npx wrangler login
npm run deploy       # -> https://ttyl-relay.<you>.workers.dev
```

### 3. Share your terminal

Tell the `ttyl` client where your relay is, once, then stream:

```bash
ttyl init -server https://ttyl-relay.<you>.workers.dev
ttyl stream
```

#### View-only or read-write

It prints two links:

```
ttyl: streaming live
  read-write: https://.../s/<id>#<key>     <- watch AND type
  view-only:  https://.../s/<id>           <- watch only
```

Send whoever you want the link that matches what they should be able to do. They
open it in a browser and they're in.

If you don't want anyone typing, hand out just the view-only link:

```bash
ttyl stream -view-only
```

#### Lifetime

The session ends when you exit your shell. It also expires on its own after a
while; set how long with `-lifetime`:

```bash
ttyl stream -lifetime 2d       # 30m, 6h, 8h, 2d, 1d12h, ...
ttyl stream -lifetime never    # only ends when you disconnect
```

Without the flag, the relay's own default applies (8 hours).

#### Saved server config

`ttyl init` saves the server to a config file in your OS's usual spot
(`~/.config/ttyl/` on Linux, `~/Library/Application Support/ttyl/` on
macOS, `%AppData%\ttyl\` on Windows), so you only do it once. You can still
pass `-server <url>` to any `stream` to override the saved value.

---

## Which relay should I run?

Both run the same code. Run your own with `ttyl serve` if you want everything on
infrastructure you control; deploy to Cloudflare if you'd rather not maintain a
box.

|  | Your own server | Cloudflare Worker |
| --- | --- | --- |
| Setup | `ttyl serve` | clone repo + `npm run deploy` |
| Where it runs | wherever you put it | Cloudflare's edge |
| Cost | your server | free tier is plenty |
| You maintain | the box and its HTTPS | nothing |

### Your own server

```bash
ttyl serve                              # http://0.0.0.0:8080
ttyl serve --port 9000 --host 127.0.0.1 # pick the port and host
PORT=9000 HOST=127.0.0.1 ttyl serve     # or set them via env vars
```

Put it behind a reverse proxy that terminates TLS so viewers connect over
`https`/`wss`. When you do, set `TRUST_PROXY=1` so the rate limiter reads the
real client IP from `X-Forwarded-For` (it ignores that header by default, since
a direct listener can't trust it).

### Cloudflare

Clone the repo (the Worker deploys from it). You need a Cloudflare account; the
free plan works. Sign in once with `npx wrangler login`, or use a scoped API
token instead:

```bash
export CLOUDFLARE_API_TOKEN=...     # an "Edit Cloudflare Workers" token from the dashboard
export CLOUDFLARE_ACCOUNT_ID=...
npm run deploy
```

The first deploy sets up a free `*.workers.dev` subdomain for you. Want a
different hostname? Change `name` in `wrangler.toml`.

---

## How private is this?

Each session has two random tokens: the id, which is
the view-only link, and a control key, which makes a link read-write. Whoever
holds a link has exactly that link's access, so only send a link to someone you
trust with that level of access.

A few things that make it safer than it might sound:

- The control key never goes in a URL the server sees. It lives in the link's
  `#fragment`, which browsers don't send to the server, and it's handed over the
  encrypted WebSocket instead. So it stays out of access logs, browser history,
  and referrer headers.
- View-only is actually view-only. The relay throws away a watcher's keystrokes;
  that's enforced on the server, not just greyed out in the page.
- Terminal output only ever lives in memory while the session is running. It's
  never written to disk.
- Sessions die on their own (8 hours by default) and end the instant you
  disconnect. After that the links 404.
- The viewer page loads everything from your own relay. No CDNs, no web fonts,
  no analytics, no third-party anything.

What it deliberately doesn't have: accounts. There's no sign-in, no audit trail,
and no way to kick one specific person off a shared link. If you need any of
that, run it behind an identity proxy like Cloudflare Access.

---

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Session lifetime (per stream) | `ttyl stream -lifetime <30m\|8h\|2d\|never>` | relay default |
| Session lifetime (relay default) | `SESSION_TTL_SECONDS` (env or `wrangler.toml`) | 8 hours |
| Sessions per IP | `[[ratelimits]]` in `wrangler.toml` (Worker) | 20 / minute |
| Server port and host | `--port`/`--host` flags or `PORT`/`HOST` env | `0.0.0.0:8080` |
| Trust `X-Forwarded-For` (Node, behind a proxy) | `TRUST_PROXY=1` env | off |
| Worker hostname | `name` in `wrangler.toml` | `ttyl-relay` |

---

## Developing

```bash
npm run dev            # run the Cloudflare Worker locally
npm run dev:node       # run the server locally with auto-reload
npm test               # unit tests
npm run typecheck      # type-check both targets

# end-to-end test against any running relay:
node test/e2e.mjs http://127.0.0.1:8787
```
