package transport

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

// The browser consumes the same bytes in its contract test. Use the production
// adapter and encoder so the fixture covers envelopes, barriers and receipts.
func TestDeliveryProtocolContract(t *testing.T) {
	w := match.MustNew([]byte(`{"name":"Protocol","schema":1,"theme":"classic","id":"protocol","author":"Tests","width":36,"height":36,"walls":[],"spawns":[{"x":4,"y":4}]}`))
	rules := match.DefaultRules()
	rules.TimeLimitTicks, rules.EndTicks = 8, 4
	if err := w.Configure(rules); err != nil {
		t.Fatal(err)
	}
	next := w.Arena
	next.ID, next.Name = "next", "Next"
	if err := w.ConfigureRotation([]maps.Arena{w.Arena, next}, nil); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1, 0)
	clock := func() time.Time { return now }
	replica, err := replication.New(replication.DefaultLimits(), clock, encodeDelivery)
	if err != nil {
		t.Fatal(err)
	}
	s := New(w, 2, nil)
	p := &peer{id: w.Add().ID, connection: "protocol-fixture", cancel: func() {}}
	r := roomRuntime{s: s, replica: replica, peers: map[int]*peer{p.id: p}, now: clock}
	var frames []any
	drain := func() {
		t.Helper()
		for {
			packet, err := replica.Next(p.id)
			if err != nil {
				t.Fatal(err)
			}
			if packet == nil {
				return
			}
			if packet.Kind == replication.State {
				frames = append(frames, map[string]string{"protobuf": base64.StdEncoding.EncodeToString(packet.Data)})
			} else {
				frames = append(frames, json.RawMessage(packet.Data))
			}
			if err := replica.Written(p.id, packet.Receipt, nil); err != nil {
				t.Fatal(err)
			}
			if err := r.receive(incoming{peer: p, message: Message{Type: "receipt", Receipt: &packet.Receipt}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	advance := func() {
		t.Helper()
		now = now.Add(34 * time.Millisecond)
		w.TimeMS = replica.TimeMS()
		for range 4 {
			w.Step()
			if err := r.transfer(); err != nil {
				t.Fatal(err)
			}
		}
		if err := replica.Publish(wire.Capture(w)); err != nil {
			t.Fatal(err)
		}
		if err := replica.OfferCues(w.Match.Round, w.Tick, wire.CaptureCues(w), now); err != nil {
			t.Fatal(err)
		}
		w.DrainCues()
	}
	if err := r.install(p); err != nil {
		t.Fatal(err)
	}
	drain()
	w.Add() // A required connected activity owed after initial admission.
	if err := r.receive(incoming{peer: p, message: Message{Type: "join", Generation: 1}}); err != nil {
		t.Fatal(err)
	}
	w.Find(p.id).State.Cooldown = 0 // Fit an accepted shot into the shortened round.
	if err := r.receive(incoming{peer: p, message: Message{Type: "input", Generation: 1, Inputs: []match.Command{{Seq: 1, Life: 1, Input: core.Input{Fire: true, Aim: core.Vec2{X: 20, Y: 4}}}}}}); err != nil {
		t.Fatal(err)
	}
	advance()
	if err := replica.Notify(p.id, encode(map[string]any{"type": "administration", "version": gameconfig.ProtocolVersion, "action": "permissions_changed"})); err != nil {
		t.Fatal(err)
	}
	if err := r.receive(incoming{peer: p, message: Message{Type: "ping", Nonce: 12}}); err != nil {
		t.Fatal(err)
	}
	drain()
	if err := r.install(p); err != nil {
		t.Fatal(err)
	}
	drain() // Same-round resynchronization retains the consumed event boundary.
	advance()
	drain()
	advance()
	if err := r.install(p); err != nil {
		t.Fatal(err)
	}
	drain() // The new map must still deliver the phase fact before its event cut.
	if !replica.Ready(p.id, 3) || w.Match.Round != 2 {
		t.Fatal("fixture did not cross all barriers")
	}
	matchFixture(t, fmt.Sprintf("testdata/v%d-delivery.json", gameconfig.ProtocolVersion), frames)
}

// The browser checks its closure and notice constants against the same fixture.
func TestSessionContract(t *testing.T) {
	matchFixture(t, "testdata/session-contract.json", map[string]any{
		"closeCodes": map[string]websocket.StatusCode{
			"roomRestarted": CloseRoomRestarted,
			"rejected":      CloseRejected,
			"removed":       CloseRemoved,
			"roomClosed":    CloseRoomClosed,
			"roomFull":      CloseRoomFull,
		},
		"closeReasons": []string{
			ReasonRoomRestarted, ReasonRoomClosed, ReasonAuthenticationExpired, ReasonServerRemoved,
			ReasonInvalidProbe, ReasonInvalidGeneration, ReasonInvalidInput, ReasonSanctionActive,
			ReasonKicked, ReasonGameSessionReplaced, ReasonInputIdle,
		},
		"noticeActions": []NoticeAction{NoticeRestart, NoticeClose, NoticeCancelled, NoticePermissionsChanged},
	})
}

// matchFixture compares value with a reviewed JSON fixture shared with the
// browser tests. UPDATE_PROTOCOL_FIXTURES=1 rewrites it after an intended change.
func matchFixture(t *testing.T, path string, value any) {
	t.Helper()
	actual, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_PROTOCOL_FIXTURES") == "1" {
		pretty, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(pretty, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, expected); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, compact.Bytes()) {
		t.Fatalf("%s: contract changed; review both languages and regenerate the fixture", path)
	}
}
