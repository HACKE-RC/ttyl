// Shared HTTP-edge helpers used by both adapters (Worker and Node): the routes,
// the security headers/CSP, and the session-lifetime (TTL) policy. Keeping these
// here is what stops the two adapters from drifting apart.

// Route patterns, identical on both targets.
export const VIEWER_PATH = /^\/s\/([^/]+)$/;
export const WS_PATH = /^\/ws\/([^/]+)\/(broadcast|view)$/;

// Content types we serve.
export const CONTENT_TYPE = {
  text: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
} as const;

// Strict CSP: everything loads from this origin, no third-party CDNs. The only
// relaxation is inline styles (the page and xterm set element styles); scripts
// are 'self' only.
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; object-src 'none'";

// securityHeaders is applied to every HTML/asset/text response.
export function securityHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

// --- Session lifetime (TTL) policy, shared so both adapters agree. ---

export const DEFAULT_TTL_SECONDS = 8 * 60 * 60;
export const MIN_TTL_SECONDS = 60;
export const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

// NEVER_TTL is the sentinel meaning "do not expire".
export const NEVER_TTL = 0;

// clampTtl bounds a positive lifetime to [MIN, MAX]; NEVER_TTL passes through.
export function clampTtl(seconds: number): number {
  if (seconds <= 0) {
    return NEVER_TTL;
  }
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(seconds)));
}

// parseTtlParam reads the client's ?ttl= seconds (from --lifetime):
//   null/invalid -> undefined  (caller uses its configured default)
//   0            -> NEVER_TTL
//   positive     -> clamped seconds
export function parseTtlParam(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return undefined;
  }
  return clampTtl(n);
}

// defaultTtlSeconds resolves the configured default (e.g. from an env var),
// falling back to DEFAULT_TTL_SECONDS, with the same clamping as overrides.
export function defaultTtlSeconds(configured: string | undefined): number {
  const raw = Number(configured);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_TTL_SECONDS;
  }
  return clampTtl(raw);
}

// resolveTtlSeconds is the single decision both adapters use at session create:
// an explicit per-session override wins (including NEVER_TTL), otherwise the
// configured default applies.
export function resolveTtlSeconds(override: number | undefined, configured: string | undefined): number {
  if (override !== undefined) {
    return override <= 0 ? NEVER_TTL : clampTtl(override);
  }
  return defaultTtlSeconds(configured);
}
