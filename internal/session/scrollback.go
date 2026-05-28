package session

// scrollbackBytes caps how many recent output bytes a session retains for
// replay to late-joining viewers. A few screens' worth keeps memory bounded
// while letting a new viewer see the current terminal contents on join.
const scrollbackBytes = 256 * 1024

// scrollback is a bounded byte buffer holding the most recent PTY output. When
// it exceeds its cap, the oldest bytes are dropped. Replaying these raw bytes
// to a fresh xterm.js reconstructs the visible screen, since the bytes include
// the terminal's own escape sequences.
//
// This is a byte window, not a full terminal emulator: if the cap trims the
// buffer mid-escape-sequence, the first painted bytes may be slightly off until
// the next full redraw. That tradeoff keeps the implementation simple and
// dependency-free.
type scrollback struct {
	max  int
	data []byte
}

// append adds output bytes, trimming the oldest bytes past the cap.
func (s *scrollback) append(p []byte) {
	s.data = append(s.data, p...)
	if len(s.data) > s.max {
		excess := len(s.data) - s.max
		s.data = s.data[:copy(s.data, s.data[excess:])]
	}
}

// snapshot returns a copy of the buffered bytes, safe for the caller to retain.
func (s *scrollback) snapshot() []byte {
	out := make([]byte, len(s.data))
	copy(out, s.data)
	return out
}
