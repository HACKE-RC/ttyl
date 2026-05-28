package client

import (
	"strings"
	"testing"
)

func TestShellEnvPinsTermToXterm256Color(t *testing.T) {
	env := shellEnv()

	var terms []string
	for _, kv := range env {
		if strings.HasPrefix(kv, "TERM=") {
			terms = append(terms, kv)
		}
	}

	if len(terms) != 1 {
		t.Fatalf("TERM entries = %v, want exactly one", terms)
	}
	if terms[0] != "TERM=xterm-256color" {
		t.Fatalf("TERM = %q, want TERM=xterm-256color", terms[0])
	}
}
