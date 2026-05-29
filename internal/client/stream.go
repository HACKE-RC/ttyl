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
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rc/astream/internal/config"
	"github.com/rc/astream/internal/wire"
	"golang.org/x/sync/errgroup"
)

// defaultServer is the relay URL used when none is configured or passed.
const defaultServer = "http://localhost:8080"

// channel buffers for the input fan-in and outbound frame fan-out.
const (
	inputBuffer  = 64
	outputBuffer = 256
	readChunk    = 4096
)

// Init handles `astream init`: it saves the relay server URL (and any other
// client settings) to the per-user config file so `astream stream` can be run
// without -server. With no -server flag it prints the current configuration.
func Init(_ context.Context, args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	server := fs.String("server", "", "default astream relay server base URL to save")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *server == "" {
		cur, err := config.Load()
		if err != nil {
			return err
		}
		path, _ := config.Path()
		if cur.Server == "" {
			fmt.Fprintf(os.Stderr, "no server configured. Set one with:\n  astream init -server <url>\n")
		} else {
			fmt.Fprintf(os.Stderr, "configured server: %s\n  (%s)\n", cur.Server, path)
		}
		return nil
	}

	normalized, err := validateServerURL(*server)
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	cfg.Server = normalized
	path, err := config.Save(cfg)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "saved server %s to %s\n", cfg.Server, path)
	return nil
}

// Run parses stream flags, creates a remote session, and streams the local PTY
// until the command exits or ctx is cancelled.
func Run(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("stream", flag.ContinueOnError)
	server := fs.String("server", "", "astream server base URL (overrides saved config)")
	viewOnly := fs.Bool("view-only", false, "only share a view-only link; viewers cannot type")
	lifetime := fs.String("lifetime", "", "max session lifetime, e.g. 30m, 8h, 2d, or 'never' (default: server's setting)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ttl, err := parseLifetime(*lifetime)
	if err != nil {
		return err
	}

	resolved, err := resolveServer(*server)
	if err != nil {
		return err
	}

	id, key, err := createSession(ctx, resolved, ttl)
	if err != nil {
		return fmt.Errorf("create session: %w", err)
	}

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, broadcastURL(resolved, id), nil)
	if err != nil {
		return fmt.Errorf("connect to server: %w", err)
	}

	// Prove read-write capability with an Auth frame as the very first message,
	// before any output. The key travels in the WebSocket body, never in the
	// URL. Legacy servers that issue no key skip this and are unaffected.
	if key != "" {
		if err := conn.WriteMessage(websocket.BinaryMessage, wire.Encode(wire.Frame{Kind: wire.Auth, Data: []byte(key)})); err != nil {
			_ = conn.Close()
			return fmt.Errorf("authenticate: %w", err)
		}
	}

	printLinks(os.Stderr, resolved, id, key, *viewOnly)

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

// validateServerURL checks that s is an http(s) URL with a host and returns it
// trimmed of a trailing slash. url.Parse alone is too lax (it accepts bare
// words like "foo"), so we assert the scheme and host explicitly.
func validateServerURL(s string) (string, error) {
	u, err := url.Parse(s)
	if err != nil {
		return "", fmt.Errorf("invalid server URL %q: %w", s, err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("invalid server URL %q: expected http://host or https://host", s)
	}
	return strings.TrimRight(s, "/"), nil
}

// resolveServer picks the relay URL: an explicit -server flag wins, otherwise
// the saved config value, otherwise the built-in default. It nudges the user
// toward `astream init` when falling back to the default.
func resolveServer(flagValue string) (string, error) {
	if flagValue != "" {
		return strings.TrimRight(flagValue, "/"), nil
	}
	cfg, err := config.Load()
	if err != nil {
		return "", err
	}
	if cfg.Server != "" {
		return cfg.Server, nil
	}
	fmt.Fprintf(os.Stderr, "astream: no -server given and none configured; using %s\n", defaultServer)
	fmt.Fprintf(os.Stderr, "astream: set a default with: astream init -server <url>\n")
	return defaultServer, nil
}

// lifetimeUnset signals that no -lifetime was given, so the server should use
// its own default. A value of 0 means "never expire"; positive values are
// seconds.
const lifetimeUnset = -1

// parseLifetime turns a human duration into seconds. It accepts Go-style units
// (s, m, h) plus days (d) and combinations like "1d12h", and the special value
// "never" (or "none"/"0") meaning no expiry. An empty string leaves it unset so
// the server's default applies.
func parseLifetime(s string) (int64, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return lifetimeUnset, nil
	}
	if s == "never" || s == "none" {
		return 0, nil
	}

	// Expand any "<n>d" day segments into hours so time.ParseDuration can take
	// over (it understands h/m/s but not d).
	expanded := dayPattern.ReplaceAllStringFunc(s, func(seg string) string {
		days, _ := strconv.Atoi(strings.TrimSuffix(seg, "d"))
		return strconv.Itoa(days*24) + "h"
	})
	d, err := time.ParseDuration(expanded)
	if err != nil {
		return 0, fmt.Errorf("invalid -lifetime %q: use values like 30m, 8h, 2d, or 'never'", s)
	}
	if d <= 0 {
		return 0, nil
	}
	return int64(d.Seconds()), nil
}

var dayPattern = regexp.MustCompile(`\d+d`)

// createSession creates a remote session and returns its id and control key.
// The key separates read-write from view-only access; servers without that
// capability (the legacy Go relay) return an empty key, in which case the
// client falls back to a single shareable link.
func createSession(ctx context.Context, server string, ttl int64) (id, key string, err error) {
	endpoint := strings.TrimRight(server, "/") + "/api/sessions"
	if ttl != lifetimeUnset {
		endpoint += "?ttl=" + strconv.FormatInt(ttl, 10)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return "", "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("server returned %s", resp.Status)
	}
	var body struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", "", err
	}
	if body.ID == "" {
		return "", "", fmt.Errorf("server returned empty session id")
	}
	return body.ID, body.Key, nil
}

// printLinks writes the shareable session URLs. With a control key the server
// supports view-only sharing: -view-only prints just the view-only link, while
// the default prints both the read-write and view-only links. Without a key the
// server has no view-only concept, so a single link is printed.
func printLinks(w io.Writer, server, id, key string, viewOnly bool) {
	base := strings.TrimRight(server, "/")
	if key == "" {
		fmt.Fprintf(w, "astream: streaming live at %s/s/%s\r\n", base, id)
		return
	}
	if viewOnly {
		fmt.Fprintf(w, "astream: streaming live (view-only)\r\n")
		fmt.Fprintf(w, "  view-only: %s/s/%s\r\n", base, id)
		return
	}
	// The control key rides in the URL fragment (#key): browsers never send it
	// to the server, so it stays out of logs and history.
	fmt.Fprintf(w, "astream: streaming live\r\n")
	fmt.Fprintf(w, "  read-write: %s/s/%s#%s\r\n", base, id, key)
	fmt.Fprintf(w, "  view-only:  %s/s/%s\r\n", base, id)
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
