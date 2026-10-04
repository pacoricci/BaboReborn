package transport

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/internal/testwire"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

func TestSocketRecoversWithoutLosingRequiredFactsAfterOneSecondPause(t *testing.T) {
	for _, mode := range []websocket.CompressionMode{websocket.CompressionDisabled, websocket.CompressionNoContextTakeover} {
		t.Run(map[websocket.CompressionMode]string{websocket.CompressionDisabled: "plain", websocket.CompressionNoContextTakeover: "deflate"}[mode], func(t *testing.T) {
			testSocketRecovery(t, mode)
		})
	}
}

func testSocketRecovery(t *testing.T, mode websocket.CompressionMode) {
	t.Helper()
	world := match.MustNew(testcontent.Map("yard"))
	rules := match.DefaultRules()
	rules.TimeLimitTicks = 40
	rules.EndTicks = 1000
	if err := world.Configure(rules); err != nil {
		t.Fatal(err)
	}
	r := startControlledOwner(t, world)
	server := httptest.NewServer(r.server.Handler(r.ctx))
	defer server.Close()
	address := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?" + admissionQuery(compatibility.GameProfile())
	connect := func() *websocket.Conn {
		c, response, err := dialAuthenticated(r.ctx, address, &websocket.DialOptions{CompressionMode: mode})
		if err != nil {
			t.Fatal(err)
		}
		extension := response.Header.Get("Sec-WebSocket-Extensions")
		if mode == websocket.CompressionDisabled && extension != "" || mode != websocket.CompressionDisabled && (!strings.Contains(extension, "permessage-deflate") || !strings.Contains(extension, "server_no_context_takeover") || !strings.Contains(extension, "client_no_context_takeover")) {
			t.Fatalf("unexpected compression negotiation: %q", extension)
		}
		t.Cleanup(func() { _ = c.CloseNow() }) //nolint:errcheck // Socket cleanup.
		var body any
		if err := readMessage(r.ctx, c, &body); err != nil {
			t.Fatal(err)
		}
		return c
	}
	paused, healthy := connect(), connect()
	var healthyTick atomic.Int64
	go func() {
		for {
			var state receivedSnapshot
			if err := readMessage(r.ctx, healthy, &state); err != nil {
				return
			}
			if state.Type == "snapshot" {
				healthyTick.Store(int64(state.Tick))
			}
		}
	}()
	// The browser stops reading/confirming; kernel writes can still succeed.
	for range 120 {
		r.wake(t, tickPeriod, 1)
	}
	if r.server.Stats().Disconnects != 0 {
		t.Fatal(r.server.Stats())
	}
	// Old commands can precede the first receipt when a blocked uplink resumes.
	if err := wsjson.Write(r.ctx, paused, Message{Type: "profile", Version: gameconfig.ProtocolVersion, Generation: 1, Nickname: "Stale"}); err != nil {
		t.Fatal(err)
	}
	var generation, phaseFacts, frames int
	for generation < 2 || phaseFacts == 0 {
		var f struct {
			replication.Envelope
			Body json.RawMessage `json:"body"`
		}
		_, raw, readErr := paused.Read(r.ctx)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if err := testwire.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		expanded, err := testwire.Expand(f.Body)
		if err != nil {
			t.Fatal(err)
		}
		f.Body = expanded
		frames++
		if f.Kind == replication.Installation {
			var b struct {
				Type  string
				State wire.Snapshot
			}
			if err := json.Unmarshal(f.Body, &b); err != nil {
				t.Fatal(err)
			}
			if b.Type != "resync" || b.State.Tick != 120 || b.State.Match.Round != 1 {
				t.Fatal(b)
			}
			if b.State.Players[0].Nickname == "Stale" {
				t.Fatal("stale command executed before recovery receipt", b.State.Players[0])
			}
			generation = f.Generation
		}
		if f.Kind == replication.Events {
			var b wire.EventBatch
			if err := json.Unmarshal(f.Body, &b); err != nil {
				t.Fatal(err)
			}
			for _, e := range b.Events {
				if e.Kind == "phase" {
					phaseFacts++
				}
			}
		}
		if err := wsjson.Write(r.ctx, paused, Message{Type: "receipt", Version: gameconfig.ProtocolVersion, Receipt: &replication.Receipt{Connection: f.Connection, Sequence: f.Sequence, Generation: f.Generation, EventThrough: f.EventThrough}}); err != nil {
			t.Fatal(err)
		}
	}
	if frames > replication.DefaultLimits().WindowFrames+3 || phaseFacts != 1 || healthyTick.Load() < 100 {
		t.Fatal(frames, phaseFacts, healthyTick.Load())
	}
	// A command from before the barrier cannot modify the freshly installed state.
	for _, m := range []Message{
		{Type: "profile", Version: gameconfig.ProtocolVersion, Generation: generation, Nickname: "Recovered"},
		{Type: "profile", Version: gameconfig.ProtocolVersion, Generation: 1, Nickname: "Stale"},
		{Type: "ping", Version: gameconfig.ProtocolVersion, Nonce: 7},
	} {
		if err := wsjson.Write(r.ctx, paused, m); err != nil {
			t.Fatal(err)
		}
	}
	for {
		var b map[string]any
		if err := readMessage(r.ctx, paused, &b); err != nil {
			t.Fatal(err)
		}
		if b["type"] == "pong" {
			break
		}
	}
	r.wake(t, tickPeriod*4, 4)
	for {
		var s receivedSnapshot
		if err := readMessage(r.ctx, paused, &s); err != nil {
			t.Fatal(err)
		}
		if s.Tick < 124 {
			continue
		}
		if s.Players[0].Nickname != "Recovered" {
			t.Fatal(s.Players[0])
		}
		break
	}
	if r.server.Stats().Disconnects != 0 {
		t.Fatal(r.server.Stats())
	}
}

func TestStoppedOwnerRejectsNewWork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
	s.Run(ctx)
	requestCtx, end := context.WithTimeout(context.Background(), time.Second)
	defer end()
	if _, err := s.Apply(requestCtx, Administration{Action: ListParticipants}); !errors.Is(err, errRoomStopped) {
		t.Fatal("stopped owner did not promptly reject work", err)
	}
}

func TestEarlyRecoveryRequestIsDeferredInsteadOfLost(t *testing.T) {
	now := time.Unix(1, 0)
	clock := func() time.Time { return now }
	replica, err := replication.New(replication.DefaultLimits(), clock, encodeDelivery)
	if err != nil {
		t.Fatal(err)
	}
	s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
	p := &peer{id: s.world.Add().ID, connection: "early", cancel: func() {}}
	r := roomRuntime{s: s, replica: replica, peers: map[int]*peer{p.id: p}, now: clock}
	if err := r.install(p); err != nil {
		t.Fatal(err)
	}
	packet, err := replica.Next(p.id)
	if err != nil || packet == nil {
		t.Fatal(packet, err)
	}
	if err := replica.Written(p.id, packet.Receipt, nil); err != nil {
		t.Fatal(err)
	}
	if err := replica.Acknowledge(p.id, packet.Receipt); err != nil {
		t.Fatal(err)
	}
	if err := r.receive(incoming{peer: p, message: Message{Type: "resync", Generation: 1}}); err != nil {
		t.Fatal(err)
	}
	if err := r.pump(); err != nil {
		t.Fatal(err)
	}
	if !p.install || replica.Generation(p.id) != 1 {
		t.Fatal("recovery was lost or not paced")
	}
	now = now.Add(time.Second)
	if err := r.pump(); err != nil {
		t.Fatal(err)
	}
	if p.install || replica.Generation(p.id) != 2 || replica.AcceptCommands(p.id, 2) {
		t.Fatal("recovery barrier was not installed")
	}
}
