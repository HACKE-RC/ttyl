package session

import (
	"testing"
	"time"

	"github.com/rc/ttyl/internal/wire"
)

func recv(t *testing.T, ch <-chan wire.Frame) wire.Frame {
	t.Helper()
	select {
	case f := <-ch:
		return f
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for frame")
		return wire.Frame{}
	}
}

func TestBroadcastFansOutToAllViewers(t *testing.T) {
	h := NewHub()
	s := h.Create()
	defer s.Close()

	a, _ := s.Subscribe()
	b, _ := s.Subscribe()

	s.Broadcast(wire.Frame{Kind: wire.Output, Data: []byte("hi")})

	for _, ch := range []<-chan wire.Frame{a, b} {
		if got := recv(t, ch); string(got.Data) != "hi" {
			t.Errorf("viewer got %q, want %q", got.Data, "hi")
		}
	}
}

func TestInputFansInToBroadcaster(t *testing.T) {
	h := NewHub()
	s := h.Create()
	defer s.Close()

	s.SendInput(wire.Frame{Kind: wire.Input, Data: []byte{0x03}})

	if got := recv(t, s.Input()); got.Kind != wire.Input || got.Data[0] != 0x03 {
		t.Errorf("broadcaster got %+v, want Input 0x03", got)
	}
}

func TestLateViewerReceivesLastResize(t *testing.T) {
	h := NewHub()
	s := h.Create()
	defer s.Close()

	s.Broadcast(wire.Frame{Kind: wire.Resize, Cols: 100, Rows: 30})
	// Give the owner goroutine a moment to record the resize.
	time.Sleep(20 * time.Millisecond)

	ch, _ := s.Subscribe()
	got := recv(t, ch)
	if got.Kind != wire.Resize || got.Cols != 100 || got.Rows != 30 {
		t.Errorf("late viewer got %+v, want Resize 100x30", got)
	}
}

func TestLateViewerReceivesScrollback(t *testing.T) {
	h := NewHub()
	s := h.Create()
	defer s.Close()

	s.Broadcast(wire.Frame{Kind: wire.Output, Data: []byte("before ")})
	s.Broadcast(wire.Frame{Kind: wire.Output, Data: []byte("join")})
	time.Sleep(20 * time.Millisecond)

	// A viewer joining after output was produced must see it, not a blank screen.
	ch, _ := s.Subscribe()
	got := recv(t, ch)
	if got.Kind != wire.Output || string(got.Data) != "before join" {
		t.Errorf("late viewer scrollback = %+v, want Output %q", got, "before join")
	}
}

func TestLateViewerReceivesResizeBeforeScrollback(t *testing.T) {
	h := NewHub()
	s := h.Create()
	defer s.Close()

	s.Broadcast(wire.Frame{Kind: wire.Resize, Cols: 80, Rows: 24})
	s.Broadcast(wire.Frame{Kind: wire.Output, Data: []byte("painted")})
	time.Sleep(20 * time.Millisecond)

	ch, _ := s.Subscribe()
	// Size must arrive first so replayed bytes paint at the right dimensions.
	if first := recv(t, ch); first.Kind != wire.Resize {
		t.Fatalf("first frame = %+v, want Resize", first)
	}
	if second := recv(t, ch); second.Kind != wire.Output || string(second.Data) != "painted" {
		t.Errorf("second frame = %+v, want Output %q", second, "painted")
	}
}

func TestSlowSubscriberIsDropped(t *testing.T) {
	h := NewHub()
	s := h.Create()
	defer s.Close()

	ch, _ := s.Subscribe()

	// Never drain ch. Overflow its buffer; the session must drop it by closing
	// the channel rather than blocking other viewers or the broadcaster.
	for i := 0; i < subscriberBuffer*2; i++ {
		s.Broadcast(wire.Frame{Kind: wire.Output, Data: []byte("x")})
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return // channel closed => dropped, as required
			}
		case <-deadline:
			t.Fatal("slow subscriber was not dropped")
		}
	}
}

func TestUnsubscribeStopsDelivery(t *testing.T) {
	h := NewHub()
	s := h.Create()
	defer s.Close()

	ch, unsub := s.Subscribe()
	unsub()

	// After unsubscribe the channel is closed; draining yields not-ok.
	select {
	case _, ok := <-ch:
		if ok {
			// drain any in-flight frame then expect close
			if _, ok := <-ch; ok {
				t.Error("channel still open after unsubscribe")
			}
		}
	case <-time.After(time.Second):
		t.Fatal("channel not closed after unsubscribe")
	}
}

func TestCloseRemovesFromHubAndIsIdempotent(t *testing.T) {
	h := NewHub()
	s := h.Create()

	if _, ok := h.Get(s.ID); !ok {
		t.Fatal("session not registered in hub")
	}

	s.Close()
	s.Close() // must not panic

	// remove runs in Close synchronously.
	if _, ok := h.Get(s.ID); ok {
		t.Error("session still in hub after Close")
	}

	select {
	case <-s.Done():
	default:
		t.Error("Done not closed after Close")
	}
}
