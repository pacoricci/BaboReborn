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
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
)

func TestSecureDiscoveryAndAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := New(match.MustNew(testcontent.Map("yard")), 2, []string{"play.example.test"})
	s.SetName("Independent room")
	go s.Run(ctx)
	h := httptest.NewTLSServer(s.Handler(ctx))
	defer h.Close()
	endpoint := "wss" + strings.TrimPrefix(h.URL, "https") + "/ws"
	options := &websocket.DialOptions{HTTPClient: h.Client(), HTTPHeader: http.Header{"Origin": []string{"https://play.example.test"}}}
	probe := func() ServerInfo {
		c, _, err := dialAuthenticated(ctx, endpoint+"?info=1", options)
		if err != nil {
			t.Fatal(err)
		}
		defer c.CloseNow() //nolint:errcheck // Server ends the discovery connection after its one response.
		var info ServerInfo
		if err := readMessage(ctx, c, &info); err != nil {
			t.Fatal(err)
		}
		return info
	}
	info := probe()
	if info.Name != "Independent room" || info.Occupied != 0 || info.Profile != compatibility.GameProfile() || info.Protocol != gameconfig.ProtocolVersion {
		t.Fatal(info)
	}
	for _, query := range []string{versionQuery(), versionQueryFor(gameconfig.ProtocolVersion-1) + "&profile=" + compatibility.GameProfile(), admissionQuery("wrong")} {
		c, response, err := dialAuthenticated(ctx, endpoint+"?"+query, options)
		if c != nil {
			_ = c.CloseNow() //nolint:errcheck // Cleanup of an unexpectedly accepted socket.
		} //nolint:errcheck // Only relevant if rejection fails.
		if err == nil || response == nil || response.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("accepted incompatible query %s: %v", query, err)
		}
	}
	// Discovery honors the browser-origin restriction too.
	denied := *options
	denied.HTTPHeader = http.Header{"Origin": []string{"https://unrelated.example.test"}}
	c, response, err := dialAuthenticated(ctx, endpoint+"?info=1", &denied)
	if c != nil {
		_ = c.CloseNow() //nolint:errcheck // Cleanup of an unexpectedly accepted socket.
	} //nolint:errcheck // Only relevant if rejection fails.
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatal("origin accepted", err)
	}
	peers := make([]*websocket.Conn, 0, 2)
	defer func() {
		for _, peer := range peers {
			_ = peer.CloseNow() //nolint:errcheck // Peer may already be closed.
		}
	}() //nolint:errcheck // Test cleanup.
	for range 2 {
		peer, _, err := dialAuthenticated(ctx, endpoint+"?"+admissionQuery(compatibility.GameProfile()), options)
		if err != nil {
			t.Fatal(err)
		}
		peers = append(peers, peer)
		var welcome map[string]any
		if err := readMessage(ctx, peer, &welcome); err != nil {
			t.Fatal(err)
		}
	}
	for info.Occupied != 2 && ctx.Err() == nil {
		info = probe()
	}
	if info.Occupied != 2 {
		t.Fatal("full server discovery unavailable", info)
	}
	extra, _, err := dialAuthenticated(ctx, endpoint+"?"+admissionQuery(compatibility.GameProfile()), options)
	if err != nil {
		t.Fatal(err)
	}
	defer extra.CloseNow() //nolint:errcheck // The full server closes first.
	_, _, err = extra.Read(ctx)
	if websocket.CloseStatus(err) != CloseRoomFull {
		t.Fatal("full admission", err)
	}
	// The test client trusts only the test certificate; TLS remains enabled.
	transport := h.Client().Transport.(*http.Transport)
	if transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("TLS verification disabled")
	}
}

func TestDiscoveryCountsParticipantsAndCapturesRules(t *testing.T) {
	w := match.MustNew(testcontent.Map("yard"))
	active := w.Add()
	w.Spawn(active)
	w.Add()
	_, err := w.AddBot(bots.NewSimple(bots.Standard(), 1), navigation.New(w.Geometry.Grid))
	if err != nil {
		t.Fatal(err)
	}
	s := New(w, 8, nil)
	before := s.Info()
	d := before.Details
	if d == nil || d.Players != 1 || d.Bots != 1 || d.Spectators != 1 || before.Occupied != 3 || d.MapID != w.Arena.ID || d.ScoreLimit != w.Rules.ScoreLimit || d.TimeLimitSeconds != w.Rules.TimeLimitTicks/gameconfig.TickHz {
		t.Fatalf("incorrect details: %+v", d)
	}
	active.Status = "dead"
	s.updateInfo()
	if s.Info().Details.Players != 1 {
		t.Fatal("dead participant counted as spectator")
	}
	active.Status = "spectator"
	s.updateInfo()
	if s.Info().Details.Spectators != 2 || before.Details.Spectators != 1 {
		t.Fatal("snapshot mutated or spectator transition missed")
	}
}
