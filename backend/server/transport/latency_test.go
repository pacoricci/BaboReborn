package transport

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestLatencyProbe(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server := httptest.NewServer(LatencyHandler(ctx, "https://portal.example"))
	defer server.Close()
	for _, origin := range []string{"https://portal.example", "https://untrusted.example", ""} {
		conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
		if origin != "https://portal.example" {
			if err == nil || response.StatusCode != http.StatusForbidden {
				t.Fatal("untrusted probe accepted")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow() //nolint:errcheck // Test cleanup.
		for range 3 {
			if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
				t.Fatal(err)
			}
			kind, data, err := conn.Read(ctx)
			if err != nil || kind != websocket.MessageText || string(data) != "pong" {
				t.Fatalf("probe reply %q: %v", data, err)
			}
		}
		if _, _, err := conn.Read(ctx); err == nil {
			t.Fatal("probe exceeded three replies")
		}
	}
}

func TestLatencyRejectsInvalidMessages(t *testing.T) {
	for _, message := range []string{"authenticate", strings.Repeat("x", 17)} {
		t.Run(message, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			server := httptest.NewServer(LatencyHandler(ctx, "https://portal.example"))
			defer server.Close()
			conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://portal.example"}}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow() //nolint:errcheck // Test cleanup.
			if err := conn.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
				t.Fatal(err)
			}
			if _, _, err := conn.Read(ctx); err == nil {
				t.Fatal("invalid probe received a reply")
			}
		})
	}
}
