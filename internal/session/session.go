// Package session implements the pure routing core of astream: a registry of
// live sessions and the fan-out/fan-in logic that connects one PTY broadcaster
// to many web viewers.
//
// This package has no knowledge of WebSockets or PTYs. It speaks only in
// wire.Frame values, which makes the routing logic directly unit-testable.
package session

import (
	"sync"

	"github.com/rc/astream/internal/wire"
)

// subscriberBuffer bounds how many frames may queue for a single viewer before
// it is considered too slow and dropped. It absorbs normal bursts while
// guaranteeing one stuck viewer can never stall the broadcaster.
const subscriberBuffer = 512

// inputBuffer bounds keystroke frames queued from viewers toward the PTY.
const inputBuffer = 256

// subscriber is a single viewer's outbound frame queue.
type subscriber struct {
	ch chan wire.Frame
}

// Session connects one broadcaster (the PTY side) to many viewers. A single
// goroutine owns all subscriber state, so callers never share a mutex: they
// interact only by sending on the session's channels.
type Session struct {
	ID string

	register   chan *subscriber
	unregister chan *subscriber
	outbound   chan wire.Frame // Output/Resize from the broadcaster
	input      chan wire.Frame // Input from viewers toward the broadcaster

	done      chan struct{}
	closeOnce sync.Once
	onClose   func()
}

// newSession starts a session's owner goroutine. onClose runs exactly once when
// the session ends, letting the Hub deregister it without coupling the two.
func newSession(id string, onClose func()) *Session {
	s := &Session{
		ID:         id,
		register:   make(chan *subscriber),
		unregister: make(chan *subscriber),
		outbound:   make(chan wire.Frame, subscriberBuffer),
		input:      make(chan wire.Frame, inputBuffer),
		done:       make(chan struct{}),
		onClose:    onClose,
	}
	go s.run()
	return s
}

// run is the session's single owner goroutine. It is the only place that reads
// or writes the subscriber set, so no locking is required.
func (s *Session) run() {
	subs := make(map[*subscriber]struct{})
	var lastResize *wire.Frame
	history := &scrollback{max: scrollbackBytes}

	closeAll := func() {
		for sub := range subs {
			close(sub.ch)
		}
	}

	for {
		select {
		case sub := <-s.register:
			subs[sub] = struct{}{}
			// Bring a late-joining viewer up to the current state: set the size
			// first, then replay buffered output so it sees the live screen
			// instead of a blank terminal.
			if lastResize != nil {
				deliver(sub, *lastResize, subs)
			}
			if data := history.snapshot(); len(data) > 0 {
				deliver(sub, wire.Frame{Kind: wire.Output, Data: data}, subs)
			}

		case sub := <-s.unregister:
			if _, ok := subs[sub]; ok {
				delete(subs, sub)
				close(sub.ch)
			}

		case f := <-s.outbound:
			switch f.Kind {
			case wire.Resize:
				rf := f
				lastResize = &rf
			case wire.Output:
				history.append(f.Data)
			}
			for sub := range subs {
				deliver(sub, f, subs)
			}

		case <-s.done:
			closeAll()
			return
		}
	}
}

// deliver performs a non-blocking send to a subscriber. A viewer that cannot
// keep up is dropped: it is removed from the set and its channel closed, which
// signals its relay to disconnect. This is the slow-subscriber backpressure
// policy in one place.
func deliver(sub *subscriber, f wire.Frame, subs map[*subscriber]struct{}) {
	select {
	case sub.ch <- f:
	default:
		delete(subs, sub)
		close(sub.ch)
	}
}

// Broadcast pushes an Output or Resize frame from the broadcaster to all
// viewers. It returns once the frame is queued, or immediately if the session
// has ended.
func (s *Session) Broadcast(f wire.Frame) {
	select {
	case s.outbound <- f:
	case <-s.done:
	}
}

// SendInput forwards a viewer keystroke frame toward the broadcaster. Input is
// dropped rather than blocking the viewer if the broadcaster is not draining.
func (s *Session) SendInput(f wire.Frame) {
	select {
	case s.input <- f:
	case <-s.done:
	default:
	}
}

// Input is the stream of viewer keystrokes consumed by the broadcaster relay.
func (s *Session) Input() <-chan wire.Frame { return s.input }

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.done }

// Subscribe adds a viewer and returns its frame stream plus an unsubscribe
// function. The stream is closed when the viewer is dropped or the session
// ends; the returned func is safe to call regardless.
func (s *Session) Subscribe() (<-chan wire.Frame, func()) {
	sub := &subscriber{ch: make(chan wire.Frame, subscriberBuffer)}
	select {
	case s.register <- sub:
	case <-s.done:
		close(sub.ch)
		return sub.ch, func() {}
	}
	return sub.ch, func() {
		select {
		case s.unregister <- sub:
		case <-s.done:
		}
	}
}

// Close ends the session, disconnecting all viewers and the broadcaster. It is
// idempotent.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		if s.onClose != nil {
			s.onClose()
		}
	})
}
