package replication

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
	"baboreborn/backend/server/wire"
)

func marshal(t testing.TB, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func populatedWorld() *match.World {
	w := match.MustNew(testcontent.Map("yard"))
	for i := range match.MaxPlayers {
		p := w.Add()
		w.Spawn(p)
		p.State.X, p.State.Y = 4+float64(i%4)*2, 4+float64(i/4)*2
		p.State.Angle = .12345678901234567
	}
	return w
}

// These are explicit serialization stress cases, not a claim that gameplay can
// produce every entity at once or that arbitrary future entities fit this budget.
func TestInstallationAndStateSizing(t *testing.T) {
	w := populatedWorld()
	s := wire.Capture(w)
	position := core.Vec3{X: 100.12345678901234, Y: 100.12345678901234, Z: .12345678901234567}
	for i := range 1024 {
		s.Projectiles = append(s.Projectiles, wire.Projectile{ID: i + 1, Kind: "minibot", OwnerID: i%16 + 1, BornTick: 123456, ExpiresTick: 234567, Position: position, Velocity: position, Turret: &wire.Turret{Angle: .12345678901234567, LastShotTick: 123456}})
	}
	for i := range 256 {
		s.Items = append(s.Items, wire.Item{ID: i + 2048, Kind: "weapon", Primary: "flamethrower", Position: position})
	}
	a := maps.Arena{Schema: maps.SchemaVersion, Theme: strings.Repeat("t", 48), ID: strings.Repeat("m", 48), Name: strings.Repeat("\u2028", 79) + "a", Author: strings.Repeat("\u2029", 79) + "a", Width: 128, Height: 128}
	for range 4096 {
		a.Walls = append(a.Walls, maps.Wall{Wall: core.Wall{X: 1, Y: 1, W: 1, H: 1, Height: 63.123456789012345}, Material: strings.Repeat("w", 48)})
	}
	for range 64 {
		a.Spawns = append(a.Spawns, core.Vec2{X: 120.12345678901234, Y: 120.12345678901234})
	}
	for range maps.MaxDecals {
		a.Decals = append(a.Decals, maps.Decal{Asset: strings.Repeat("d", 48), X: 100.12345678901234, Y: 100.12345678901234, W: 31.123456789012345, H: 31.123456789012345, Angle: .12345678901234567, Opacity: .12345678901234567})
	}
	a.Teams = &maps.TeamLayout{Blue: maps.TeamBase{Base: core.Vec2{X: 80, Y: 80}, Spawns: a.Spawns[:32]}, Red: maps.TeamBase{Base: core.Vec2{X: 100, Y: 100}, Spawns: a.Spawns[:32]}}
	mapBytes := marshal(t, a)
	if _, err := maps.Parse(mapBytes); err != nil {
		t.Fatal(err)
	}
	body := marshal(t, map[string]any{"type": "installation", "id": 1, "state": s, "arena": a, "shotGeometry": match.Geometry, "tickHz": 120, "snapshotHz": 30})
	l := DefaultLimits()
	if len(marshal(t, s)) > l.StateBytes || len(body) > l.FrameBytes || maps.MaxBytes+l.StateBytes+(64<<10) > l.FrameBytes {
		t.Fatal("installation/state no longer fit default payload budgets")
	}
	f := setup(t, nil)
	if err := f.room.Append(wire.CaptureRequiredEvents(w)); err != nil {
		t.Fatal(err)
	}
	if err := f.room.Add(1, strings.Repeat("c", 128), Baseline{State: s, Body: body}); err != nil {
		t.Fatal(err)
	}
	install := f.take(1, Installation)
	f.finish(1, install, true)
	s.Tick++
	if err := f.room.Publish(s); err != nil {
		t.Fatal(err)
	}
	statePacket := f.take(1, State)
	t.Logf("16 players / 1024 projectiles / 256 items: state=%d B; 4096 walls / 64 decals: map=%d B; full installation=%d B; state envelope=%d B", len(marshal(t, s)), len(mapBytes), len(install.Data), len(statePacket.Data))
}

func TestRequiredEventSizingFromSixteenBotCombat(t *testing.T) {
	w := match.MustNew(testcontent.Map("yard"))
	w.Rules.ScoreLimit, w.Rules.TimeLimitTicks = 0, 0
	nav := navigation.New(w.Geometry.Grid)
	for i := range match.MaxPlayers {
		if _, err := w.AddBot(bots.NewSimple(bots.Standard(), uint32(9109+i)), nav); err != nil {
			t.Fatal(err)
		}
	}
	w.DrainEvents()
	const window = 5 * gameconfig.TickHz
	var sizes, counts [window]int
	bytes, records, peakBytes, peakRecords, peakEvent, peakTickBytes, peakState := 0, 0, 0, 0, 0, 0, 0
	for i := range 30 * gameconfig.TickHz {
		w.Step()
		b := wire.CaptureRequiredEvents(w)
		tickBytes := 0
		for _, e := range b.Events {
			size := len(marshal(t, e))
			tickBytes += size
			peakEvent = max(peakEvent, size)
		}
		bytes += tickBytes - sizes[i%window]
		records += len(b.Events) - counts[i%window]
		sizes[i%window], counts[i%window] = tickBytes, len(b.Events)
		peakBytes, peakRecords, peakTickBytes = max(peakBytes, bytes), max(peakRecords, records), max(peakTickBytes, tickBytes)
		if w.Tick%match.SnapshotEvery == 0 {
			peakState = max(peakState, len(marshal(t, wire.Capture(w))))
		}
		w.DrainEvents()
	}
	l := DefaultLimits()
	if peakBytes == 0 || peakBytes > l.ReliableBytes || peakRecords > l.ReliableRecords || peakEvent > l.EventBytes || peakTickBytes > l.JournalBytes || peakState > l.StateBytes {
		t.Fatal("combat capture no longer fits", peakBytes, peakRecords, peakEvent, peakTickBytes, peakState)
	}
	t.Logf("Yard / 16 bots / seed 9109+i / 30 simulated seconds: largest 5 s window=%d B / %d R records; largest R=%d B; largest tick=%d B; largest state=%d B", peakBytes, peakRecords, peakEvent, peakTickBytes, peakState)
}

// A conservative synthetic production envelope supplements the replay's
// observed peak: 16 broadcast facts per tick, for just under the 5 s deadline.
func TestRequiredBurstFitsFiveSecondRetentionBudget(t *testing.T) {
	f := setup(t, nil)
	s := state(0, 0, 1)
	installation := marshal(t, map[string]any{"state": s, "map": strings.Repeat("m", (2<<20)-4096)})
	if err := f.room.Add(1, "loading-scene", Baseline{State: s, Body: installation}); err != nil {
		t.Fatal(err)
	}
	f.finish(1, f.take(1, Installation), false)
	for tick := 1; tick < 5*gameconfig.TickHz; tick++ {
		f.now = f.now.Add(time.Second / gameconfig.TickHz)
		var events []wire.Event
		for owner := 1; owner <= match.MaxPlayers; owner++ {
			participant := wire.Participant{ID: owner, Nickname: strings.Repeat("N", 24), Team: "blue"}
			a := &wire.Activity{ID: f.room.cut + owner, Tick: tick, Round: 1, Kind: "kill", Actor: participant, Victim: &participant, Weapon: "flamethrower"}
			events = append(events, wire.Event{Kind: "activity", OwnerID: owner, Life: 100, Activity: a, Position: core.Vec3{X: .12345678901234567, Y: .12345678901234567, Z: .12345678901234567}})
		}
		f.append(tick, events...)
	}
	u := f.usage(1)
	if u.Closed != "" || u.ReliableRecords != 599*16+1 {
		t.Fatal(u)
	}
	t.Logf("16 R records/tick over 599 ticks plus pending 2 MiB installation: retained=%d B / %d records; per-peer budget=%d B / %d records", u.ReliableBytes, u.ReliableRecords, f.room.limits.ReliableBytes, f.room.limits.ReliableRecords)
}

func BenchmarkReplicate16Peers(b *testing.B) {
	benchmarkDelivery(b, false, 0)
}

func BenchmarkPinnedJournal(b *testing.B) {
	for _, backlog := range []int{0, 10000} {
		b.Run(fmt.Sprintf("retained-%d", backlog), func(b *testing.B) {
			benchmarkDelivery(b, true, backlog)
		})
	}
}

func benchmarkDelivery(b *testing.B, private bool, backlog int) {
	now := time.Unix(1000, 0)
	r, err := New(DefaultLimits(), func() time.Time { return now }, encodeTestEnvelope)
	if err != nil {
		b.Fatal(err)
	}
	w := populatedWorld()
	s := wire.Capture(w)
	if err := r.Append(wire.CaptureRequiredEvents(w)); err != nil {
		b.Fatal(err)
	}
	base := Baseline{State: s, Body: marshal(b, s)}
	drain := func(first int) {
		for id := first; id <= 16; id++ {
			for {
				p, err := r.Next(id)
				if err != nil {
					b.Fatal(err)
				}
				if p == nil {
					break
				}
				if err := r.Written(id, p.Receipt, nil); err != nil {
					b.Fatal(err)
				}
				if err := r.Acknowledge(id, p.Receipt); err != nil {
					b.Fatal(err)
				}
			}
		}
	}
	for id := 1; id <= 16; id++ {
		if err := r.Add(id, fmt.Sprintf("connection-%d", id), base); err != nil {
			b.Fatal(err)
		}
	}
	drain(1)
	if backlog > 0 {
		batch := wire.EventBatch{Tick: s.Tick, After: r.cut, Through: r.cut + backlog}
		for i := range backlog {
			batch.Events = append(batch.Events, wire.Event{ID: r.cut + i + 1, Tick: s.Tick, Round: 1, Kind: "hit", OwnerID: 1, Life: 1})
		}
		if err := r.Append(batch); err != nil {
			b.Fatal(err)
		}
	}
	first, count, kind := 1, 16, "damage"
	if private {
		first, count, kind = 2, 15, "hit"
	}
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		s.Tick += match.SnapshotEvery
		batch := wire.EventBatch{Tick: s.Tick, After: r.cut, Through: r.cut + count}
		for i := range count {
			batch.Events = append(batch.Events, wire.Event{ID: r.cut + i + 1, Tick: s.Tick, Round: 1, Kind: kind, OwnerID: first + i, Life: 1, Amount: 10, Weapon: "smg"})
		}
		if err := r.Append(batch); err != nil {
			b.Fatal(err)
		}
		s.EventCut = batch.Through
		if err := r.Publish(s); err != nil {
			b.Fatal(err)
		}
		drain(first)
	}
	b.StopTimer()
	if u := r.UsageRoom(); u.JournalEvents != backlog {
		b.Fatal("benchmark stopped retaining the slow peer's history", u)
	}
}
