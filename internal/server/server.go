package server

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rc/astream/internal/session"
	"github.com/rc/astream/web"
)

// Run parses serve flags and runs the relay/web server until ctx is cancelled.
func Run(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", ":8080", "address to listen on")
	if err := fs.Parse(args); err != nil {
		return err
	}

	srv := &http.Server{Addr: *addr, Handler: newServer().routes()}

	errCh := make(chan error, 1)
	go func() {
		fmt.Printf("astream server listening on %s\n", *addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// server holds the HTTP-layer dependencies. The session hub is the only state.
type server struct {
	hub      *session.Hub
	upgrader websocket.Upgrader
}

func newServer() *server {
	return &server{
		hub: session.NewHub(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			// The session ID is the capability; any origin holding it may connect.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/sessions", s.createSession)
	mux.HandleFunc("GET /s/{id}", s.viewerPage)
	mux.HandleFunc("GET /static/viewer.js", s.viewerScript)
	mux.HandleFunc("GET /ws/{id}/broadcast", s.broadcastSocket)
	mux.HandleFunc("GET /ws/{id}/view", s.viewSocket)
	mux.HandleFunc("GET /", s.index)
	return mux
}

func (s *server) index(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprintln(w, "astream relay server. Start a stream with: astream stream")
}

func (s *server) createSession(w http.ResponseWriter, _ *http.Request) {
	sess := s.hub.Create()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"id": sess.ID})
}

func (s *server) viewerPage(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.hub.Get(r.PathValue("id")); !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	serveAsset(w, "index.html", "text/html; charset=utf-8")
}

func (s *server) viewerScript(w http.ResponseWriter, _ *http.Request) {
	serveAsset(w, "viewer.js", "application/javascript; charset=utf-8")
}

func (s *server) broadcastSocket(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.hub.Get(r.PathValue("id"))
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	serveBroadcaster(conn, sess)
}

func (s *server) viewSocket(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.hub.Get(r.PathValue("id"))
	if !ok {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	serveViewer(conn, sess)
}

func serveAsset(w http.ResponseWriter, name, contentType string) {
	data, err := web.Assets.ReadFile(name)
	if err != nil {
		http.Error(w, "asset not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = w.Write(data)
}
