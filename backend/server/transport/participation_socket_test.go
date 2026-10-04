package transport

import (
	"context"
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

func TestAccountSocketReplacementAndRenewal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
	s.SetAdmission(func(_ *http.Request, join func(Identity) error) error {
		return join(Identity{Subject: "account:one", Session: "session", Expires: time.Now().Add(time.Minute)})
	})
	go s.Run(ctx)
	server := httptest.NewServer(s.Handler(ctx))
	defer server.Close()
	connect := func() (*websocket.Conn, int) {
		t.Helper()
		socket, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ws?"+admissionQuery(compatibility.GameProfile()), nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = socket.CloseNow() }) //nolint:errcheck // Test cleanup.
		if err = writeMessage(ctx, socket, Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Proof: "valid"}); err != nil {
			t.Fatal(err)
		}
		var welcome struct {
			Type string
			ID   int
		}
		if err = readMessage(ctx, socket, &welcome); err != nil {
			t.Fatal(err)
		}
		if welcome.Type != "welcome" {
			t.Fatal(welcome)
		}
		return socket, welcome.ID
	}
	first, id := connect()
	second, newID := connect()
	if id == newID {
		t.Fatal("player identity reused")
	}
	for {
		var value any
		err := readMessage(ctx, first, &value)
		if err == nil {
			continue
		}
		var reason string
		if closeErr, ok := err.(websocket.CloseError); ok {
			reason = closeErr.Reason
		}
		if websocket.CloseStatus(err) != CloseRemoved || !strings.Contains(err.Error(), ReasonGameSessionReplaced) {
			t.Fatal("missing replacement notice", reason, err)
		}
		break
	}
	if err := writeMessage(ctx, second, Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Proof: "renewed"}); err != nil {
		t.Fatal(err)
	}
	// Reading a ping reply proves the renewal frame was processed without replacing the socket.
	if err := writeMessage(ctx, second, Message{Type: "ping", Version: gameconfig.ProtocolVersion, Nonce: 123}); err != nil {
		t.Fatal(err)
	}
	for {
		var value struct {
			Type  string
			Nonce int
		}
		if err := readMessage(ctx, second, &value); err != nil {
			t.Fatal(err)
		}
		if value.Type == "pong" && value.Nonce == 123 {
			break
		}
	}
	people, err := s.Apply(ctx, Administration{Action: ListParticipants})
	if err != nil || len(people) != 1 || people[0].ID != newID {
		t.Fatal("replacement lost after old close/renewal", people, err)
	}
}
