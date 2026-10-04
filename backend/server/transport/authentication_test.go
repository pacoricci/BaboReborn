package transport

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/match"
)

func TestAuthenticationPrecedesSnapshotsAndRenewsSameSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
	s.SetAdmission(func(r *http.Request, join func(Identity) error) error {
		token := r.Header.Get("Authorization")
		who := Identity{Subject: "account:" + strings.Repeat("a", 32), Session: "one", Expires: time.Now().Add(200 * time.Millisecond)}
		switch token {
		case "Bearer initial":
		case "Bearer renewed":
			who.Expires = time.Now().Add(3 * time.Second)
		case "Bearer other":
			who.Subject = "account:" + strings.Repeat("b", 32)
		default:
			return fmt.Errorf("invalid_proof")
		}
		return join(who)
	})
	go s.Run(ctx)
	server := httptest.NewServer(s.Handler(ctx))
	defer server.Close()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?"+admissionQuery(compatibility.GameProfile()), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.CloseNow() //nolint:errcheck // Test cleanup.
	received := make(chan map[string]any, 32)
	closed := make(chan error, 1)
	go func() {
		for {
			var value map[string]any
			err := readMessage(ctx, socket, &value)
			if err != nil {
				closed <- err
				return
			}
			select {
			case received <- value:
			case <-ctx.Done():
				return
			}
		}
	}()
	select {
	case msg := <-received:
		t.Fatal("snapshot before authentication", msg)
	case <-time.After(50 * time.Millisecond):
	}
	if err = writeMessage(ctx, socket, Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Proof: "initial"}); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-received:
		if msg["type"] != "welcome" {
			t.Fatal(msg)
		}
	case <-ctx.Done():
		t.Fatal("no welcome")
	}
	if err = writeMessage(ctx, socket, Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Proof: "renewed"}); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(450 * time.Millisecond)
	defer deadline.Stop()
	waiting := true
	for waiting {
		select {
		case <-received:
		case err := <-closed:
			t.Fatal("renewed connection expired", err)
		case <-deadline.C:
			waiting = false
		}
	}
	if err = writeMessage(ctx, socket, Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Proof: "other"}); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-closed:
		if websocket.CloseStatus(err) != CloseRejected {
			t.Fatal("identity switch not rejected", err)
		}
	case <-ctx.Done():
		t.Fatal("identity switch remained connected")
	}
}
func TestInitialAuthenticationTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
	go s.Run(ctx)
	server := httptest.NewServer(s.Handler(ctx))
	defer server.Close()
	socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?"+admissionQuery(compatibility.GameProfile()), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.CloseNow() //nolint:errcheck // Test cleanup.
	_, _, err = socket.Read(ctx)
	if err == nil || ctx.Err() != nil {
		t.Fatal("missing five-second authentication timeout", err)
	}
}
