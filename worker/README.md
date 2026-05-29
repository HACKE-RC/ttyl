# ttyl

Share your terminal with a link.

`ttyl` streams a live terminal session to anyone with the URL. They watch in
their browser as it happens, and if you give them the right link, they can type
back into your session too. It's like screen-sharing for the terminal, except
there's nothing for the other person to install. They just open a link.

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

### 1. Put up a relay

You only need one. Pick whichever suits you; they behave the same.

On Cloudflare (free, and there's no server to babysit):

```bash
cd worker
npm install
npx wrangler login
npm run deploy
```

You'll get back a URL like `https://ttyl-relay.<you>.workers.dev`.

Or on your own machine:

```bash
cd worker
npm install
npm start          # listens on http://0.0.0.0:8080
```

Run that one behind HTTPS (Caddy or nginx is fine) so links work over `wss://`.

### 2. Share your terminal

Tell the `ttyl` client where your relay is, once, then stream:

```bash
ttyl init -server https://ttyl-relay.<you>.workers.dev
ttyl stream
```

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

The session ends when you exit your shell. It also expires on its own after a
while; set how long with `-lifetime`:

```bash
ttyl stream -lifetime 2d       # 30m, 6h, 8h, 2d, 1d12h, ...
ttyl stream -lifetime never    # only ends when you disconnect
```

Without the flag, the relay's own default applies (8 hours).

`ttyl init` saves the server to a config file in your OS's usual spot
(`~/.config/ttyl/` on Linux, `~/Library/Application Support/ttyl/` on
macOS, `%AppData%\ttyl\` on Windows), so you only do it once. You can still
pass `-server <url>` to any `stream` to override the saved value.

---

## Which relay should I run?

If you don't want to think about it, use Cloudflare. The free tier is plenty and
there's nothing to maintain. Run your own server if you'd rather keep everything
on infrastructure you control, or you're already hosting things.

|  | Cloudflare Worker | Your own server |
| --- | --- | --- |
| Setup | `npm run deploy` | `npm start` |
| Where it runs | Cloudflare's edge | wherever you put it |
| Cost | free tier is plenty | your server |
| You maintain | nothing | the box and its HTTPS |

### Cloudflare

You need a Cloudflare account; the free plan works. Sign in once with
`npx wrangler login`, or use a scoped API token instead:

```bash
export CLOUDFLARE_API_TOKEN=...     # an "Edit Cloudflare Workers" token from the dashboard
export CLOUDFLARE_ACCOUNT_ID=...
npm run deploy
```

The first deploy sets up a free `*.workers.dev` subdomain for you. Want a
different hostname? Change `name` in `wrangler.toml`.

### Your own server

```bash
npm start                                  # http://0.0.0.0:8080
npm start -- --port 9000 --host 127.0.0.1  # pick the port and host
PORT=9000 HOST=127.0.0.1 npm start         # or set them via env vars
```

Put it behind a reverse proxy that terminates TLS so viewers connect over
`https`/`wss`. When you do, set `TRUST_PROXY=1` so the rate limiter reads the
real client IP from `X-Forwarded-For` (it ignores that header by default, since
a direct listener can't trust it).

---

## How private is this?

Worth being clear about, since you're sharing a live shell.

The link is the credential. Each session has two random tokens: the id, which is
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
