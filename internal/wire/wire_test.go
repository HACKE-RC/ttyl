package wire

import (
	"bytes"
	"testing"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	cases := []struct {
		name string
		in   Frame
	}{
		{"output", Frame{Kind: Output, Data: []byte("hello\x1b[0m world")}},
		{"input", Frame{Kind: Input, Data: []byte{0x03}}},
		{"empty output", Frame{Kind: Output, Data: []byte{}}},
		{"resize", Frame{Kind: Resize, Cols: 120, Rows: 40}},
		{"resize zero", Frame{Kind: Resize, Cols: 0, Rows: 0}},
		{"resize max", Frame{Kind: Resize, Cols: 65535, Rows: 65535}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Decode(Encode(tc.in))
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if got.Kind != tc.in.Kind {
				t.Errorf("Kind = %d, want %d", got.Kind, tc.in.Kind)
			}
			if got.Cols != tc.in.Cols || got.Rows != tc.in.Rows {
				t.Errorf("dims = %dx%d, want %dx%d", got.Cols, got.Rows, tc.in.Cols, tc.in.Rows)
			}
			if tc.in.Kind != Resize && !bytes.Equal(got.Data, tc.in.Data) {
				t.Errorf("Data = %q, want %q", got.Data, tc.in.Data)
			}
		})
	}
}

func TestDecodeCopiesData(t *testing.T) {
	buf := Encode(Frame{Kind: Output, Data: []byte("abc")})
	got, err := Decode(buf)
	if err != nil {
		t.Fatal(err)
	}
	// Mutating the source buffer must not affect the decoded frame.
	for i := range buf {
		buf[i] = 0
	}
	if !bytes.Equal(got.Data, []byte("abc")) {
		t.Errorf("decoded data aliases source buffer: %q", got.Data)
	}
}

func TestDecodeErrors(t *testing.T) {
	if _, err := Decode(nil); err != ErrShortFrame {
		t.Errorf("empty buffer: got %v, want ErrShortFrame", err)
	}
	if _, err := Decode([]byte{byte(Resize), 0x00}); err != ErrShortFrame {
		t.Errorf("short resize: got %v, want ErrShortFrame", err)
	}
	if _, err := Decode([]byte{0xFF}); err == nil {
		t.Error("unknown kind: expected error, got nil")
	}
}
