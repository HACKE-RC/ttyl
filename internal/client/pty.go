package client

import (
	"os"
	"os/exec"
	"strings"

	"github.com/creack/pty"
	"golang.org/x/term"
)

// terminal owns the local PTY running the user's shell/command and the local
// stdin's raw-mode state. It is the only place that touches PTY mechanics.
type terminal struct {
	ptmx    *os.File
	cmd     *exec.Cmd
	restore func() error
}

// startTerminal spawns command (or the user's shell when empty) attached to a
// new PTY, puts the local stdin into raw mode, and matches the PTY size to the
// local terminal. Call Close to restore the terminal and reap the process.
//
// The PTY is created at the local terminal's size up front. Resizing it after
// the shell has started would deliver SIGWINCH and make shells like zsh redraw
// their prompt, which shows up as a duplicated prompt in the stream; starting
// at the right size avoids that.
func startTerminal(command []string) (*terminal, error) {
	cmd := buildCommand(command)
	ptmx, err := pty.StartWithSize(cmd, localWinsize())
	if err != nil {
		return nil, err
	}

	oldState, err := term.MakeRaw(int(os.Stdin.Fd()))
	if err != nil {
		_ = ptmx.Close()
		_ = cmd.Process.Kill()
		return nil, err
	}

	return &terminal{
		ptmx:    ptmx,
		cmd:     cmd,
		restore: func() error { return term.Restore(int(os.Stdin.Fd()), oldState) },
	}, nil
}

func buildCommand(command []string) *exec.Cmd {
	if len(command) == 0 {
		shell := os.Getenv("SHELL")
		if shell == "" {
			shell = "/bin/sh"
		}
		command = []string{shell}
	}
	cmd := exec.Command(command[0], command[1:]...)
	cmd.Env = shellEnv()
	return cmd
}

// shellEnv returns the environment for the spawned shell with TERM pinned to
// xterm-256color. The session is rendered by xterm.js in the browser, which
// speaks xterm-256color; pinning it guarantees the shell emits escape sequences
// the viewer understands. It also avoids a "dumb"/unset TERM, under which
// shells cannot redraw the prompt in place and reprint it instead (seen as a
// duplicated prompt in the stream).
func shellEnv() []string {
	var env []string
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "TERM=") {
			env = append(env, kv)
		}
	}
	return append(env, "TERM=xterm-256color")
}

// localWinsize reports the local terminal's dimensions, falling back to a
// standard 80x24 if they cannot be read.
func localWinsize() *pty.Winsize {
	rows, cols, err := pty.Getsize(os.Stdin)
	if err != nil {
		return &pty.Winsize{Rows: 24, Cols: 80}
	}
	return &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
}

// size reports the current local terminal dimensions without touching the PTY,
// for broadcasting the initial size to viewers.
func (t *terminal) size() (cols, rows uint16) {
	ws := localWinsize()
	return ws.Cols, ws.Rows
}

// resizeToLocal matches the PTY window to the local terminal on a genuine
// resize and reports the new dimensions so the caller can broadcast it.
func (t *terminal) resizeToLocal() (cols, rows uint16, err error) {
	ws := localWinsize()
	if err := pty.Setsize(t.ptmx, ws); err != nil {
		return 0, 0, err
	}
	return ws.Cols, ws.Rows, nil
}

func (t *terminal) Read(p []byte) (int, error)  { return t.ptmx.Read(p) }
func (t *terminal) Write(p []byte) (int, error) { return t.ptmx.Write(p) }

// Close restores the local terminal, closes the PTY, and waits for the child.
// It is safe to call more than once.
func (t *terminal) Close() error {
	if t.restore != nil {
		_ = t.restore()
		t.restore = nil
	}
	err := t.ptmx.Close()
	_ = t.cmd.Wait()
	return err
}
