package transport

import (
	"context"
	"net/http"
	"time"

	"baboreborn/backend/identity"

	"github.com/coder/websocket"
)

// LatencyHandler measures transport latency without touching room state or identity.
func LatencyHandler(ctx context.Context, origin string) http.Handler {
	slots := make(chan struct{}, 128)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			identity.Error(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		if r.Header.Get("Origin") != origin {
			identity.Error(w, http.StatusForbidden, "origin_refused")
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			identity.Error(w, http.StatusServiceUnavailable, "probe_capacity_reached")
			return
		}
		// The exact portal origin was checked above; no wildcard origin matching.
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow() //nolint:errcheck // Always release the bounded probe connection.
		conn.SetReadLimit(16)
		probe, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		for range 3 {
			kind, data, err := conn.Read(probe)
			if err != nil || kind != websocket.MessageText || string(data) != "ping" {
				return
			}
			if err := conn.Write(probe, websocket.MessageText, []byte("pong")); err != nil {
				return
			}
		}
	})
}
