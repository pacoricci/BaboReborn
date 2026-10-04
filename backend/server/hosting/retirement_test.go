package hosting

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/transport"
)

func roomTestSocket(t *testing.T, ctx context.Context, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() }) //nolint:errcheck // Test socket cleanup.
	frame, err := json.Marshal(transport.Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Guest: strings.Repeat("a", 32)})
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		t.Fatal(err)
	}
	return conn
}

func roomTestWelcome(t *testing.T, ctx context.Context, conn *websocket.Conn) {
	t.Helper()
	_, frame, err := conn.Read(ctx)
	if err != nil || !bytes.Contains(frame, []byte(`"type":"welcome"`)) {
		t.Fatalf("missing welcome: %s, %v", frame, err)
	}
}

func roomTestClose(t *testing.T, ctx context.Context, conn *websocket.Conn, code websocket.StatusCode, reason string) {
	t.Helper()
	for {
		_, frame, err := conn.Read(ctx)
		if err == nil {
			if bytes.Contains(frame, []byte(`"type":"welcome"`)) {
				t.Fatal("removed room admitted a player")
			}
			continue
		}
		if websocket.CloseStatus(err) != code || !strings.Contains(err.Error(), reason) {
			t.Fatalf("close = %v, want %d %s", err, code, reason)
		}
		return
	}
}

func TestRemoveRetiresInFlightRoomAdmission(t *testing.T) {
	for _, tc := range []struct {
		name          string
		restart       bool
		cancelHandler bool
		code          websocket.StatusCode
		reason        string
	}{
		{name: "closed", code: transport.CloseRoomClosed, reason: transport.ReasonRoomClosed},
		{name: "restarted", restart: true, code: transport.CloseRoomRestarted, reason: transport.ReasonRoomRestarted},
		{name: "restarted_after_handler_stops", restart: true, cancelHandler: true, code: transport.CloseRoomRestarted, reason: transport.ReasonRoomRestarted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			m := New(ctx, nil, nil, 1)
			entered, release := make(chan struct{}), make(chan struct{})
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			var attempts atomic.Int32
			m.SetAdmission(func(_ *http.Request, join func(transport.Identity) error) error {
				if attempts.Add(1) == 2 {
					close(entered)
					<-release
				}
				return join(transport.Identity{})
			})
			s := transport.New(match.MustNew(testcontent.Map("yard")), 2, nil)
			s.SetAdmission(m.admit)
			if err := m.Install("one", s); err != nil {
				t.Fatal(err)
			}
			oldHandler := m.rooms["one"].handler
			stopOldHandler := m.rooms["one"].cancel
			server := httptest.NewServer(m)
			defer server.Close()
			url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?room=one&v=" + strconv.Itoa(gameconfig.ProtocolVersion) + "&profile=" + compatibility.GameProfile()
			current := roomTestSocket(t, ctx, url)
			roomTestWelcome(t, ctx, current)
			waiting := roomTestSocket(t, ctx, url)
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("admission did not reach the blocked join")
			}
			if err := m.Remove(ctx, "one", tc.restart); err != nil {
				t.Fatal(err)
			}
			if len(m.Directory().Rooms) != 0 {
				t.Fatal("retired room remains in directory")
			}
			roomTestClose(t, ctx, current, tc.code, tc.reason)
			if tc.cancelHandler {
				stopOldHandler()
			}
			close(release)
			roomTestClose(t, ctx, waiting, tc.code, tc.reason)
			response := httptest.NewRecorder()
			oldHandler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ws?", nil))
			if response.Code != http.StatusServiceUnavailable {
				t.Fatalf("old handler returned %d, want 503", response.Code)
			}
		})
	}
}

func TestAdministrativeDisconnectKeepsRoomOpen(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m := New(ctx, nil, nil, 1)
	s := transport.New(match.MustNew(testcontent.Map("yard")), 2, nil)
	if err := m.Install("one", s); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(m)
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?room=one&v=" + strconv.Itoa(gameconfig.ProtocolVersion) + "&profile=" + compatibility.GameProfile()
	first := roomTestSocket(t, ctx, url)
	roomTestWelcome(t, ctx, first)
	if err := m.Apply(ctx, transport.Administration{Action: transport.Disconnect, Code: transport.CloseRemoved, Reason: transport.ReasonKicked}); err != nil {
		t.Fatal(err)
	}
	roomTestClose(t, ctx, first, transport.CloseRemoved, transport.ReasonKicked)
	second := roomTestSocket(t, ctx, url)
	roomTestWelcome(t, ctx, second)
}
