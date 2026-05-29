package server

import (
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rc/ttyl/internal/session"
	"github.com/rc/ttyl/internal/wire"
)

// Keepalive timings. The server pings idle connections and drops any peer that
// fails to pong within pongWait, so dead sockets behind proxies are reclaimed.
const (
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

// serveBroadcaster bridges the PTY-side WebSocket to a session: inbound
// Output/Resize frames fan out to viewers, and viewer Input frames are written
// back. When the broadcaster disconnects, the session ends.
func serveBroadcaster(conn *websocket.Conn, sess *session.Session) {
	defer conn.Close()
	defer sess.Close()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		pumpToSocket(conn, sess.Input(), sess.Done())
	}()

	readFrames(conn, func(f wire.Frame) {
		switch f.Kind {
		case wire.Output, wire.Resize:
			sess.Broadcast(f)
		case wire.Input:
			// A broadcaster does not send input; ignore.
		}
	})

	sess.Close()  // stop the pump
	conn.Close()  // unblock a pending write
	wg.Wait()
}

// serveViewer bridges a viewer WebSocket to a session: subscribed frames are
// written to the socket, and inbound Input frames are forwarded to the PTY.
// A viewer leaving does not end the session.
func serveViewer(conn *websocket.Conn, sess *session.Session) {
	defer conn.Close()

	frames, unsubscribe := sess.Subscribe()
	defer unsubscribe()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		pumpToSocket(conn, frames, sess.Done())
	}()

	readFrames(conn, func(f wire.Frame) {
		switch f.Kind {
		case wire.Input:
			sess.SendInput(f)
		case wire.Output, wire.Resize:
			// Viewers do not drive output or size; ignore.
		}
	})

	conn.Close() // unblock the pump if it is mid-write
	wg.Wait()
}

// pumpToSocket writes frames from a source channel to the socket until the
// channel closes, the session ends, or a write fails. It also emits periodic
// pings, and is the only writer on conn so gorilla's single-writer rule holds.
func pumpToSocket(conn *websocket.Conn, frames <-chan wire.Frame, done <-chan struct{}) {
	ping := time.NewTicker(pingPeriod)
	defer ping.Stop()

	for {
		select {
		case <-done:
			return
		case f, ok := <-frames:
			if !ok {
				return
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, wire.Encode(f)); err != nil {
				return
			}
		case <-ping.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(pingPeriod)); err != nil {
				return
			}
		}
	}
}

// readFrames reads binary messages from the socket, decodes each into a frame,
// and hands it to onFrame. It returns when the connection closes or errors. It
// is the only reader on conn.
func readFrames(conn *websocket.Conn, onFrame func(wire.Frame)) {
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		f, err := wire.Decode(data)
		if err != nil {
			continue
		}
		onFrame(f)
	}
}
