package session

import (
	"bytes"
	"strings"
	"testing"
)

func TestScrollbackKeepsRecentBytesWithinCap(t *testing.T) {
	sb := &scrollback{max: 8}
	sb.append([]byte("abc"))
	sb.append([]byte("def"))
	if got := sb.snapshot(); !bytes.Equal(got, []byte("abcdef")) {
		t.Fatalf("under cap: got %q, want %q", got, "abcdef")
	}
}

func TestScrollbackTrimsOldestPastCap(t *testing.T) {
	sb := &scrollback{max: 5}
	sb.append([]byte("abcdefgh")) // single append already over cap
	if got := sb.snapshot(); !bytes.Equal(got, []byte("defgh")) {
		t.Fatalf("single over-cap append: got %q, want %q", got, "defgh")
	}
	sb.append([]byte("ij")) // pushes window forward across appends
	if got := sb.snapshot(); !bytes.Equal(got, []byte("fghij")) {
		t.Fatalf("incremental trim: got %q, want %q", got, "fghij")
	}
}

func TestScrollbackSnapshotIsACopy(t *testing.T) {
	sb := &scrollback{max: 16}
	sb.append([]byte("hello"))
	snap := sb.snapshot()
	sb.append([]byte("world"))
	if !bytes.Equal(snap, []byte("hello")) {
		t.Fatalf("snapshot mutated by later append: got %q", snap)
	}
}

func TestScrollbackHandlesLargeTotalWithinBound(t *testing.T) {
	sb := &scrollback{max: 1024}
	chunk := []byte(strings.Repeat("x", 200))
	for i := 0; i < 100; i++ {
		sb.append(chunk)
	}
	if got := len(sb.snapshot()); got != 1024 {
		t.Fatalf("buffer not bounded: len = %d, want 1024", got)
	}
}
