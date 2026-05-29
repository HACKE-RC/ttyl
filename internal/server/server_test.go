package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rc/ttyl/internal/wire"
)

// dialWS opens a WebSocket against an httptest server URL + path.
func dialWS(t *testing.T, base, path string) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(base, "http") + path
	conn, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	return conn
}

func readFrame(t *testing.T, conn *websocket.Conn) wire.Frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	f, err := wire.Decode(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return f
}

func writeFrame(t *testing.T, conn *websocket.Conn, f wire.Frame) {
	t.Helper()
	if err := conn.WriteMessage(websocket.BinaryMessage, wire.Encode(f)); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func createSessionID(t *testing.T, base string) string {
	t.Helper()
	resp, err := http.Post(base+"/api/sessions", "application/json", nil)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	defer resp.Body.Close()
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode session: %v", err)
	}
	if body.ID == "" {
		t.Fatal("empty session id")
	}
	return body.ID
}

func TestEndToEndBroadcastAndInput(t *testing.T) {
	ts := httptest.NewServer(newServer().routes())
	defer ts.Close()

	id := createSessionID(t, ts.URL)

	bcast := dialWS(t, ts.URL, "/ws/"+id+"/broadcast")
	defer bcast.Close()
	v1 := dialWS(t, ts.URL, "/ws/"+id+"/view")
	defer v1.Close()
	v2 := dialWS(t, ts.URL, "/ws/"+id+"/view")
	defer v2.Close()

	// Allow the viewer handlers to subscribe before broadcasting.
	time.Sleep(100 * time.Millisecond)

	writeFrame(t, bcast, wire.Frame{Kind: wire.Output, Data: []byte("hello")})
	for _, v := range []*websocket.Conn{v1, v2} {
		if got := readFrame(t, v); got.Kind != wire.Output || string(got.Data) != "hello" {
			t.Errorf("viewer got %+v, want Output \"hello\"", got)
		}
	}

	writeFrame(t, bcast, wire.Frame{Kind: wire.Resize, Cols: 90, Rows: 25})
	for _, v := range []*websocket.Conn{v1, v2} {
		if got := readFrame(t, v); got.Kind != wire.Resize || got.Cols != 90 || got.Rows != 25 {
			t.Errorf("viewer got %+v, want Resize 90x25", got)
		}
	}

	writeFrame(t, v1, wire.Frame{Kind: wire.Input, Data: []byte("ls\n")})
	if got := readFrame(t, bcast); got.Kind != wire.Input || string(got.Data) != "ls\n" {
		t.Errorf("broadcaster got %+v, want Input \"ls\\n\"", got)
	}
}

func TestLateViewerGetsCurrentSize(t *testing.T) {
	ts := httptest.NewServer(newServer().routes())
	defer ts.Close()

	id := createSessionID(t, ts.URL)
	bcast := dialWS(t, ts.URL, "/ws/"+id+"/broadcast")
	defer bcast.Close()

	writeFrame(t, bcast, wire.Frame{Kind: wire.Resize, Cols: 111, Rows: 33})
	time.Sleep(100 * time.Millisecond)

	// A viewer joining after the resize must immediately learn the size.
	late := dialWS(t, ts.URL, "/ws/"+id+"/view")
	defer late.Close()
	if got := readFrame(t, late); got.Kind != wire.Resize || got.Cols != 111 || got.Rows != 33 {
		t.Errorf("late viewer got %+v, want Resize 111x33", got)
	}
}

func TestUnknownSessionRejected(t *testing.T) {
	ts := httptest.NewServer(newServer().routes())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/s/does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("viewer page for missing session: status %d, want 404", resp.StatusCode)
	}
}
