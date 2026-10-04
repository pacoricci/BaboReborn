package replication

import (
	"encoding/json"
	"testing"
	"time"

	"baboreborn/backend/core"
	"baboreborn/backend/internal/testwire"
	"baboreborn/backend/server/wire"
)

func TestEntityCacheOwnsTurretValuesAndAccountsCompleteState(t *testing.T) {
	s := state(4, 0, 1)
	s.Items = []wire.Item{{ID: 5, Kind: "weapon", Primary: "smg", Motion: "bounce", MotionTick: 4, Position: core.Vec3{X: 2, Z: .125}, Velocity: core.Vec3{X: 3, Z: 4}, ExpiresTick: 1200}}
	turret := &wire.Turret{Angle: .25, LastShotTick: 2}
	s.Projectiles = []wire.Projectile{{ID: 6, Kind: "minibot", Motion: "fixed", Turret: turret}, {ID: 7, Kind: "grenade", Motion: "fixed"}}
	first, err := captureCheckpoint(s, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.size != len(binarySnapshot(t, s.ForRecipient(0))) {
		t.Fatalf("state bytes %d != full encoding %d", first.size, len(binarySnapshot(t, s.ForRecipient(0))))
	}
	original := string(first.groups.projectiles.records[6])
	turret.Angle = .75
	next, err := captureCheckpoint(s, first)
	if err != nil {
		t.Fatal(err)
	}
	if string(first.groups.projectiles.records[6]) != original {
		t.Fatal("producer changed retained turret")
	}
	patch := next.groups.projectiles.delta(first.groups.projectiles)
	var changed struct {
		Upsert []wire.Projectile `json:"upsert"`
		Remove []int             `json:"remove"`
	}
	if err := func() error {
		b, err := testwire.Projectiles(patch)
		if err != nil {
			return err
		}
		return json.Unmarshal(b, &changed)
	}(); err != nil {
		t.Fatal(err)
	}
	if len(changed.Upsert) != 1 || changed.Upsert[0].ID != 6 || changed.Upsert[0].Turret.Angle != .75 {
		t.Fatal(changed)
	}
	for _, empty := range []bool{false, true} {
		s.Items, s.Projectiles = nil, nil
		if empty {
			s.Items, s.Projectiles = []wire.Item{}, []wire.Projectile{}
		}
		c, err := captureCheckpoint(s, next)
		if err != nil {
			t.Fatal(err)
		}
		if c.size != len(binarySnapshot(t, s.ForRecipient(0))) {
			t.Fatalf("empty=%v: %d != %d", empty, c.size, len(binarySnapshot(t, s.ForRecipient(0))))
		}
	}
}

func TestHealthyRecipientsFollowPublicationDespiteEncodingJitter(t *testing.T) {
	f := setup(t, nil)
	f.room.Pace(30)
	f.join(1)
	start := f.now
	for tick := 1; tick <= 90; tick++ {
		f.now = start.Add(time.Duration(tick) * time.Second / 30)
		if tick%2 == 1 {
			f.now = f.now.Add(3 * time.Millisecond)
		}
		f.publish(tick, 0, 1)
		p := f.take(1, State)
		f.finish(1, p, true)
		if extra, err := f.room.Next(1); err != nil || extra != nil {
			t.Fatal("publication delivered twice", extra, err)
		}
	}
}

func TestUnchangedEntityPublicationDoesNotAllocateIndexes(t *testing.T) {
	values := []wire.Item{{ID: 1, Kind: "grenade", Motion: "fixed"}, {ID: 2, Kind: "health", Motion: "fixed"}}
	id := func(v wire.Item) int { return v.ID }
	version := func(v wire.Item) wire.Item { return v }
	previous, err := encodeEntities(values, id, version, entityGroup[wire.Item]{}, wire.EncodeItem)
	if err != nil {
		t.Fatal(err)
	}
	allocations := testing.AllocsPerRun(100, func() {
		next, err := encodeEntities(values, id, version, previous, wire.EncodeItem)
		if err != nil || &next.order[0] != &previous.order[0] {
			t.Fatal("unchanged publication did not share immutable indexes", err)
		}
	})
	if allocations != 0 {
		t.Fatalf("unchanged entity publication allocated %v times", allocations)
	}
	values[0].ExpiresTick = 120
	next, err := encodeEntities(values, id, version, previous, wire.EncodeItem)
	if err != nil || next.versions[1].ExpiresTick != 120 || previous.versions[1].ExpiresTick != 0 {
		t.Fatal("changed publication mutated a recipient baseline", err)
	}
}
