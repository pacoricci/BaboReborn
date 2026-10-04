package replication

import (
	"encoding/json"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/server/wire"
)

func assertItems(t *testing.T, p *Packet, want []wire.Item, present bool) {
	t.Helper()
	fields := body[map[string]json.RawMessage](t, p)
	if p.Kind == Installation {
		if err := json.Unmarshal(fields["state"], &fields); err != nil {
			t.Fatal(err)
		}
	}
	got, exists := fields["items"]
	if p.Kind == State && exists {
		var patch struct {
			Upsert []wire.Item `json:"upsert"`
			Remove []int       `json:"remove"`
		}
		if err := json.Unmarshal(got, &patch); err != nil {
			t.Fatal(err)
		}
		if len(want) == 0 {
			if len(patch.Remove) != 1 || patch.Remove[0] != 1 {
				t.Fatal("missing removal", patch)
			}
		}
		got = marshal(t, patch.Upsert)
	}
	if exists != present || present && string(got) != string(marshal(t, want)) {
		t.Fatalf("items present=%v, want %v; got %s, want %s", exists, present, got, marshal(t, want))
	}
}

func TestItemsSurviveCoalescingBlockedCreditAndIndependentReaders(t *testing.T) {
	f := setup(t, func(l *Limits) { l.WindowFrames = l.ControlReserveFrames + 1 })
	f.join(1)
	f.join(2)
	items := []wire.Item{{ID: 1, Kind: "grenade", Position: core.Vec3{X: 4, Y: 4, Z: 1}}}
	publish := func(tick int) {
		s := state(tick, 0, 1)
		s.Items = items
		if err := f.room.Publish(s); err != nil {
			t.Fatal(err)
		}
	}
	publish(1)
	first := f.take(1, State)
	assertItems(t, first, items, true)
	f.finish(1, first, false)
	items[0].Position.Z = .5 // A falling pickup still updates its exact height.
	publish(2)
	if p, err := f.room.Next(1); err != nil || p != nil {
		t.Fatal("exhausted credit admitted state", p, err)
	}
	items[0].Position.Z = .15
	publish(3) // Replaces a change that neither peer received.
	want := append([]wire.Item(nil), items...)
	items[0].Position.X = 999 // Producer mutation cannot alter a retained capture.
	if err := f.room.Acknowledge(1, first.Receipt); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{1, 2} {
		p := f.take(id, State)
		assertItems(t, p, want, true)
		f.finish(id, p, true)
	}
	items = want
	publish(4)
	for _, id := range []int{1, 2} {
		p := f.take(id, State)
		assertItems(t, p, nil, false)
		f.finish(id, p, true)
	}
	items = []wire.Item{} // Last pickup collected or expired: [] explicitly clears it.
	publish(5)
	p := f.take(1, State)
	assertItems(t, p, items, true)
	f.finish(1, p, false)
	publish(6)
	p = f.take(2, State) // Clear must survive replacement for the slower peer too.
	assertItems(t, p, items, true)
	f.finish(2, p, true)
}

func TestItemBaselineIsFullOnJoinResyncAndMapInstallation(t *testing.T) {
	f := setup(t, nil)
	s := state(0, 0, 1)
	s.Items = []wire.Item{{ID: 1, Kind: "weapon", Primary: "smg", Position: core.Vec3{X: 4, Y: 4, Z: .15}}}
	if err := f.room.Add(1, "items", baseline(t, s)); err != nil {
		t.Fatal(err)
	}
	install := f.take(1, Installation)
	assertItems(t, install, s.Items, true)
	f.finish(1, install, true)
	for _, round := range []int{1, 2} {
		s.Tick++
		if err := f.room.Publish(s); err != nil {
			t.Fatal(err)
		}
		// A new generation replaces the pending old list, even within one round.
		s.Tick++
		s.Match.Round = round
		s.Items[0].Primary = "sniper"
		s.Items[0].Position.X += 1
		if err := f.room.Install(1, baseline(t, s)); err != nil {
			t.Fatal(err)
		}
		install = f.take(1, Installation)
		assertItems(t, install, s.Items, true)
		s.Tick++
		if err := f.room.Publish(s); err != nil {
			t.Fatal(err)
		}
		f.finish(1, install, true)
		p := f.take(1, State)
		assertItems(t, p, nil, false)
		f.finish(1, p, true)
	}
}
