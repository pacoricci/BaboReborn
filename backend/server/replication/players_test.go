package replication

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"baboreborn/backend/core"
	"baboreborn/backend/server/wire"
)

func TestRecipientCheckpointIsCompleteAndRosterIsShared(t *testing.T) {
	f := setup(t, nil)
	s := groupState(0)
	for id := 2; id <= 3; id++ {
		p := s.Players[0]
		p.ID = id
		s.Players = append(s.Players, p)
	}
	for i := range s.Players {
		p := &s.Players[i]
		p.Ack, p.Seed = 91+i, uint32(4294967295-i)
		p.State = core.Player{X: 4.123456789, Y: 5.987654321, VX: 3.1415926535, VY: -1.23456789, Angle: .37, Cooldown: .71, Spread: 8.8,
			Equipment: core.Equipment{Primary: "shotgun", Secondary: "knives", Shells: 6, Charge: .21, SinceShot: .03, Protection: .42, MeleeDelay: .13,
				Heat: .44, Overheated: true, FireTime: .22, ScopeHeight: 7, RocketActive: true, RocketAge: .4, PrimaryAction: "rocket", Barrel: 1,
				SecondaryActivated: true, Grenades: 2, Molotovs: 1, ThrowDelay: .18, Action: "grenade"}}
		installGroups(t, f, p.ID, s)
	}
	for step, status := range []string{"spectator", "alive", "dead", "alive"} {
		s.Tick += 4
		f.now = f.now.Add(34 * time.Millisecond)
		for i := range s.Players {
			s.Players[i].Status = status
			s.Players[i].Life = step
			s.Players[i].BornTick = step * 4
			s.Players[i].DiedTick = step * 3
		}
		// Reordering must never make one owner receive another owner's mechanics.
		s.Players[0], s.Players[2] = s.Players[2], s.Players[0]
		publishState(t, f, s)
		var roster json.RawMessage
		for _, want := range s.Players {
			packet := f.take(want.ID, State)
			fields := body[map[string]json.RawMessage](t, packet)
			if roster == nil {
				roster = fields["players"]
			} else if string(roster) != string(fields["players"]) {
				t.Fatal("roster was personalized")
			}
			var local wire.LocalCheckpoint
			if err := json.Unmarshal(fields["local"], &local); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(local, want.Checkpoint()) {
				t.Fatalf("incomplete owner %d: %+v", want.ID, local)
			}
			assertRemoteFields(t, fields["players"])
			f.finish(want.ID, packet, true)
		}
	}
	c, err := captureCheckpoint(s, nil)
	if err != nil {
		t.Fatal(err)
	}
	largest := 0
	for _, p := range s.Players {
		largest = max(largest, len(binarySnapshot(t, s.ForRecipient(p.ID))))
	}
	if c.size != largest {
		t.Fatalf("state limit accounting %d != largest recipient %d", c.size, largest)
	}
	// Producer mutation cannot rewrite a delayed recipient checkpoint.
	before := string(c.locals[1])
	s.Players[2].State.Equipment.Charge = 99
	if string(c.locals[1]) != before {
		t.Fatal("local encoding aliases producer")
	}
}

func assertRemoteFields(t *testing.T, encoded json.RawMessage) {
	t.Helper()
	var players []map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &players); err != nil {
		t.Fatal(err)
	}
	for _, p := range players {
		for _, key := range []string{"ack", "seed", "died"} {
			if p[key] != nil {
				t.Fatalf("remote %s leaked", key)
			}
		}
		var state map[string]json.RawMessage
		if err := json.Unmarshal(p["state"], &state); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"x", "y", "angle", "cooldown", "equipment"} {
			if state[key] == nil {
				t.Fatalf("missing remote %s", key)
			}
		}
		if len(state) != 5 {
			t.Fatal("remote simulation internals leaked", string(p["state"]))
		}
		var e map[string]json.RawMessage
		if err := json.Unmarshal(state["equipment"], &e); err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"primary", "secondary", "shells", "charge", "sinceShot", "protection", "meleeDelay"} {
			if e[key] == nil {
				t.Fatalf("missing presentation %s", key)
			}
		}
		if len(e) != 7 {
			t.Fatal("remote equipment internals leaked", string(state["equipment"]))
		}
	}
}
