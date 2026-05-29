// RFC 4648 base32 without padding, matching Go's
// base32.StdEncoding.WithPadding(base32.NoPadding) so session IDs minted here
// are byte-for-byte identical to the ones the Go server produced.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32NoPad(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

// idBytes mirrors the Go constant: 15 random bytes encode to a 24-character
// unguessable token, and the link is the sole capability for a session.
const ID_BYTES = 15;

export function newSessionID(): string {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase32NoPad(bytes);
}
