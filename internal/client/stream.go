// Package client implements the astream streaming side: it wraps a shell in a
// local PTY, mirrors it to the user's terminal, and bridges it to a relay
// server so viewers can watch and type over the web.
package client

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gorilla/websocket"
	"github.com/rc/astream/internal/wire"
	"golang.org/x/sync/errgroup"
)

// channel buffers for the input fan-in and outbound frame fan-out.
const (
	inputBuffer  = 64
	outputBuffer = 256
	readChunk    = 4096
)

// Run parses stream flags, creates a remote session, and streams the local PTY
// until the command exits or ctx is cancelled.
func Run(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stream", flag.ContinueOnError)
	server := fs.String("server", "http://localhost:8080", "astream server base URL")
	if err := fs.Parse(args); err != nil {
		return err
	}

	id, err := createSession(ctx, *server)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, broadcastURL(*server, id), nil)
	if err != nil {
		return fmt.Errorf("connect to server: %w", err)
	}

	fmt.Fprintf(os.Stderr, "astream: streaming live at %s/s/%s\r\n", strings.TrimRight(*server, "/"), id)

	t, err := startTerminal(fs.Args())
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("start terminal: %w", err)
	}
	defer t.Close()

	return pump(ctx, t, conn)
}

// pump runs the bidirectional bridge between the PTY and the server. All
// shutdown is driven by a single cancel: whichever side ends first (the shell
// exiting or the connection dropping) cancels the rest, and the closer unblocks
// any goroutine still parked in a blocking read.
func pump(ctx context.Context, t *terminal, conn *websocket.Conn) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	inputCh := make(chan []byte, inputBuffer)
	outCh := make(chan wire.Frame, outputBuffer)

	if cols, rows := t.size(); cols > 0 && rows > 0 {
		select {
		case outCh <- wire.Frame{Kind: wire.Resize, Cols: cols, Rows: rows}:
		case <-runCtx.Done():
		}
	}

	go func() {
		<-runCtx.Done()
		_ = conn.Close()
		_ = t.Close()
	}()

	var g errgroup.Group
	g.Go(func() error { return ptyToServer(runCtx, t, os.Stdout, outCh, cancel) })
	g.Go(func() error { return serverToInput(runCtx, conn, inputCh, cancel) })
	g.Go(func() error { return writeFrames(runCtx, conn, outCh, cancel) })
	g.Go(func() error { return writeInput(runCtx, t, inputCh, cancel) })
	g.Go(func() error { return watchResize(runCtx, t, outCh) })

	// Local keystrokes run detached: os.Stdin reads cannot be reliably
	// unblocked on shutdown, so we let the process exit reap this goroutine.
	go readStdin(runCtx, inputCh)

	return g.Wait()
}

// ptyToServer mirrors PTY output to the local terminal and broadcasts it. When
// the PTY closes (the shell exited), it cancels the run.
func ptyToServer(ctx context.Context, t *terminal, local io.Writer, outCh chan<- wire.Frame, cancel context.CancelFunc) error {
	defer cancel()
	buf := make([]byte, readChunk)
	for {
		n, err := t.Read(buf)
		if n > 0 {
			if _, werr := local.Write(buf[:n]); werr != nil {
				return werr
			}
			select {
			case outCh <- wire.Frame{Kind: wire.Output, Data: append([]byte(nil), buf[:n]...)}:
			case <-ctx.Done():
				return nil
			}
		}
		if err != nil {
			return nil // PTY closed: normal end of session
		}
	}
}

// serverToInput reads viewer keystrokes from the server and feeds the PTY input
// channel. It cancels the run when the connection ends.
func serverToInput(ctx context.Context, conn *websocket.Conn, inputCh chan<- []byte, cancel context.CancelFunc) error {
	defer cancel()
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return nil
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		f, err := wire.Decode(data)
		if err != nil || f.Kind != wire.Input {
			continue
		}
		select {
		case inputCh <- f.Data:
		case <-ctx.Done():
			return nil
		}
	}
}

// writeFrames is the sole writer on conn: it drains outbound frames until the
// run ends.
func writeFrames(ctx context.Context, conn *websocket.Conn, outCh <-chan wire.Frame, cancel context.CancelFunc) error {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return nil
		case f := <-outCh:
			if err := conn.WriteMessage(websocket.BinaryMessage, wire.Encode(f)); err != nil {
				return nil
			}
		}
	}
}

// writeInput is the sole writer to the PTY: it drains the input channel fed by
// both local keystrokes and remote viewers.
func writeInput(ctx context.Context, t *terminal, inputCh <-chan []byte, cancel context.CancelFunc) error {
	defer cancel()
	for {
		select {
		case <-ctx.Done():
			return nil
		case data := <-inputCh:
			if _, err := t.Write(data); err != nil {
				return nil
			}
		}
	}
}

// watchResize relays local terminal resizes to the PTY and to viewers.
func watchResize(ctx context.Context, t *terminal, outCh chan<- wire.Frame) error {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGWINCH)
	defer signal.Stop(sig)

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-sig:
			cols, rows, err := t.resizeToLocal()
			if err != nil {
				continue
			}
			select {
			case outCh <- wire.Frame{Kind: wire.Resize, Cols: cols, Rows: rows}:
			case <-ctx.Done():
				return nil
			}
		}
	}
}

// readStdin forwards local keystrokes into the PTY input channel.
func readStdin(ctx context.Context, inputCh chan<- []byte) {
	buf := make([]byte, readChunk)
	for {
		n, err := os.Stdin.Read(buf)
		if n > 0 {
			select {
			case inputCh <- append([]byte(nil), buf[:n]...):
			case <-ctx.Done():
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func createSession(ctx context.Context, server string) (string, error) {
	endpoint := strings.TrimRight(server, "/") + "/api/sessions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("server returned %s", resp.Status)
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	if body.ID == "" {
		return "", fmt.Errorf("server returned empty session id")
	}
	return body.ID, nil
}

func broadcastURL(server, id string) string {
	u, err := url.Parse(strings.TrimRight(server, "/"))
	if err != nil {
		return server
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = "/ws/" + id + "/broadcast"
	return u.String()
}
