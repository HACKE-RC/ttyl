// Package wire defines the single source of truth for the astream protocol.
//
// Frames are exchanged over a WebSocket between the streaming client (the PTY
// broadcaster) and the relay server, and between the server and web viewers.
// Nothing outside this package may inspect or assemble the byte layout.
package wire

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Kind identifies the meaning of a Frame's payload.
type Kind uint8

const (
	// Output carries raw terminal bytes flowing from the PTY to viewers.
	Output Kind = iota
	// Input carries raw keystroke bytes flowing from a viewer to the PTY.
	Input
	// Resize carries the broadcaster's authoritative terminal dimensions.
	Resize
	// Auth is the first frame a socket sends; its payload is the control key
	// (UTF-8), or empty for a view-only viewer. It keeps the key out of the
	// connection URL, and therefore out of request logs and browser history.
	Auth
)

// resizePayloadLen is the fixed payload size of a Resize frame: two uint16s.
const resizePayloadLen = 4

// ErrShortFrame is returned when a buffer is too small to be a valid frame.
var ErrShortFrame = errors.New("wire: short frame")

// Frame is a single decoded protocol message.
//
// For Output and Input, Data holds the raw bytes and Cols/Rows are unused.
// For Resize, Cols/Rows hold the dimensions and Data is unused.
type Frame struct {
	Kind Kind
	Data []byte
	Cols uint16
	Rows uint16
}

// Encode serializes a frame as a single byte slice: one Kind byte followed by
// the payload. The returned slice is freshly allocated and owned by the caller.
func Encode(f Frame) []byte {
	switch f.Kind {
	case Output, Input, Auth:
		buf := make([]byte, 1+len(f.Data))
		buf[0] = byte(f.Kind)
		copy(buf[1:], f.Data)
		return buf
	case Resize:
		buf := make([]byte, 1+resizePayloadLen)
		buf[0] = byte(f.Kind)
		binary.BigEndian.PutUint16(buf[1:3], f.Cols)
		binary.BigEndian.PutUint16(buf[3:5], f.Rows)
		return buf
	default:
		panic(fmt.Sprintf("wire: encode unknown kind %d", f.Kind))
	}
}

// Decode parses a single frame produced by Encode. It copies any payload bytes
// so the caller may retain the result independent of the source buffer.
func Decode(buf []byte) (Frame, error) {
	if len(buf) < 1 {
		return Frame{}, ErrShortFrame
	}
	kind := Kind(buf[0])
	payload := buf[1:]
	switch kind {
	case Output, Input, Auth:
		data := make([]byte, len(payload))
		copy(data, payload)
		return Frame{Kind: kind, Data: data}, nil
	case Resize:
		if len(payload) < resizePayloadLen {
			return Frame{}, ErrShortFrame
		}
		return Frame{
			Kind: kind,
			Cols: binary.BigEndian.Uint16(payload[0:2]),
			Rows: binary.BigEndian.Uint16(payload[2:4]),
		}, nil
	default:
		return Frame{}, fmt.Errorf("wire: unknown kind %d", kind)
	}
}
