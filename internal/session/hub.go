package session

import (
	"crypto/rand"
	"encoding/base32"
	"sync"
)

// idBytes is the number of random bytes per session ID. 15 bytes encodes to a
// 24-character unguessable token and keeps the link the sole capability.
const idBytes = 15

var idEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// Hub is the registry of live sessions, keyed by ID.
type Hub struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

// NewHub returns an empty session registry.
func NewHub() *Hub {
	return &Hub{sessions: make(map[string]*Session)}
}

// Create starts a new session with a fresh random ID and registers it. The
// session deregisters itself from the hub when it closes.
func (h *Hub) Create() *Session {
	id := newID()
	s := newSession(id, func() { h.remove(id) })

	h.mu.Lock()
	h.sessions[id] = s
	h.mu.Unlock()
	return s
}

// Get returns the session with the given ID, if it exists.
func (h *Hub) Get(id string) (*Session, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.sessions[id]
	return s, ok
}

func (h *Hub) remove(id string) {
	h.mu.Lock()
	delete(h.sessions, id)
	h.mu.Unlock()
}

func newID() string {
	b := make([]byte, idBytes)
	if _, err := rand.Read(b); err != nil {
		panic("session: crypto/rand failed: " + err.Error())
	}
	return idEncoding.EncodeToString(b)
}
