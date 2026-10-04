package match

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/maps"
)

func arena() []byte {
	b, err := json.Marshal(Arena{Name: "Synthetic match test", Schema: 1, Theme: "classic", ID: "synthetic", Author: "Tests", Width: 20, Height: 20, Walls: []maps.Wall{}, Spawns: []core.Vec2{{X: 4, Y: 4}, {X: 16, Y: 16}}})
	if err != nil {
		panic(err)
	} // Constant fixture must be serializable.
	return b
}
func TestNewRejectsInvalidArenaAndOwnsItsCopy(t *testing.T) {
	a, err := maps.Parse(arena())
	if err != nil {
		t.Fatal(err)
	}
	invalid := a
	invalid.Schema = 0
	if w, err := New(invalid); err == nil || w != nil {
		t.Fatal("invalid arena accepted", w)
	}
	w, err := New(a)
	if err != nil {
		t.Fatal(err)
	}
	// A room rotation keeps the source arena; the world must not alias it.
	a.Spawns[0] = core.Vec2{X: 9, Y: 9}
	if w.Arena.Spawns[0] != (core.Vec2{X: 4, Y: 4}) {
		t.Fatal(w.Arena.Spawns)
	}
}
func alivePair() (*World, *Player, *Player) {
	w := MustNew(arena())
	a, b := w.Add(), w.Add()
	w.Spawn(a)
	w.Spawn(b)
	a.State = core.NewPlayer(core.Vec2{X: 4, Y: 4}, 0)
	b.State = core.NewPlayer(core.Vec2{X: 7, Y: 4}, math.Pi)
	return w, a, b
}
func TestSpectatorSpawnAndRespawn(t *testing.T) {
	w := MustNew(arena())
	a, b := w.Add(), w.Add()
	if a.Status != "spectator" {
		t.Fatal(a)
	}
	w.Spawn(a)
	w.Spawn(b)
	if math.Hypot(a.State.X-b.State.X, a.State.Y-b.State.Y) < 10 {
		t.Fatal("spawn not farthest")
	}
	a.Status = "dead"
	a.Died = w.Tick
	if w.Spawn(a) {
		t.Fatal("early respawn")
	}
	for i := 0; i < gameconfig.TickHz; i++ {
		w.Step()
	}
	if !w.Spawn(a) || a.HP != 100 || a.State.Cooldown != 1 || a.State.VX != 0 || a.Life != 2 {
		t.Fatal("bad respawn", a)
	}
}
func TestRejectInvalidAndDuplicateInputs(t *testing.T) {
	w, a, _ := alivePair()
	c := Command{Seq: 1, Life: a.Life, Input: core.Input{X: 1, Aim: core.Vec2{X: 10, Y: 4}}}
	if w.Submit(a, []Command{c, c}) == nil {
		t.Fatal("out of order batch")
	}
	if w.Submit(a, []Command{c}) != nil {
		t.Fatal("valid input")
	}
	if w.Submit(a, []Command{c}) != nil || len(a.queue) != 1 {
		t.Fatal("duplicate replay")
	}
	c.Seq = 2
	c.X = math.NaN()
	if w.Submit(a, []Command{c}) == nil {
		t.Fatal("NaN")
	}
	c.X = 2
	if w.Submit(a, []Command{c}) == nil {
		t.Fatal("arbitrary speed")
	}
	c.X = 1
	c.Seq = 2000
	if w.Submit(a, []Command{c}) == nil {
		t.Fatal("sequence jump")
	}
}
func TestOneInputPerServerTickAndRelease(t *testing.T) {
	w, a, _ := alivePair()
	for i := 1; i <= 60; i++ {
		if err := w.Submit(a, []Command{{Seq: i, Life: a.Life, Input: core.Input{X: 1, Fire: true, Aim: core.Vec2{X: 10, Y: 4}}}}); err != nil {
			t.Fatal(err)
		}
	}
	w.Step()
	if a.Ack != 1 {
		t.Fatal("client advanced time")
	}
	w.Release(a)
	if a.Ack != 60 || len(a.queue) != 0 {
		t.Fatal("release did not flush")
	}
	x := a.State.X
	for i := 0; i < 120; i++ {
		w.Step()
	}
	if a.State.X-x > .1 || len(shotEvents(w)) != 0 {
		t.Fatal("stuck input")
	}
}
func TestInputTimeoutDiscardsQueuedFire(t *testing.T) {
	w, a, _ := alivePair()
	for i := 1; i <= 60; i++ {
		if err := w.Submit(a, []Command{{Seq: i, Life: a.Life, Input: core.Input{Fire: true, Aim: core.Vec2{X: 10, Y: 4}}}}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 31; i++ {
		w.Step()
	}
	if len(a.queue) != 0 || a.Ack != 60 {
		t.Fatal("timeout did not clear backlog")
	}
}
func TestDamageImmunityCadenceDeath(t *testing.T) {
	w, a, b := alivePair()
	a.State.Cooldown = 0
	seq := 0
	for i := 0; i < 600 && b.Status == "alive"; i++ {
		// Reset the shooter's placement to isolate cadence and damage from recoil motion.
		a.State.X = 4
		a.State.Y = 4
		a.State.VX = 0
		a.State.VY = 0
		a.State.Angle = 0
		seq++
		if err := w.Submit(a, []Command{{Seq: seq, Life: a.Life, Input: core.Input{Fire: true, Aim: core.Vec2{X: 7, Y: 4}}}}); err != nil {
			t.Fatal(err)
		}
		w.Step()
		if w.Tick <= 204 && b.HP != 100 {
			t.Fatalf("immunity ended at tick %d", w.Tick)
		}
	}
	if b.Status != "dead" || a.Kills != 1 || b.Deaths != 1 {
		t.Fatalf("death not authoritative: %+v", b)
	}
	if len(shotEvents(w)) > w.Tick/12+1 {
		t.Fatal("cadence exceeded")
	}
	if w.Spawn(b) {
		t.Fatal("instant respawn")
	}
	for i := 0; i < 120; i++ {
		w.Step()
	}
	if !w.Spawn(b) || b.HP != 100 {
		t.Fatal("respawn failed")
	}
}
func TestCoverBlocksDamage(t *testing.T) {
	w, a, b := alivePair()
	w.Geometry.Walls = []core.Wall{{X: 5, Y: 3, W: 1, H: 3}}
	w.Geometry.Grid = core.NewGrid(core.Wall{W: 20, H: 20}, w.Geometry.Walls)
	w.Tick = 500
	a.State.Cooldown = 0
	if err := w.Submit(a, []Command{{Seq: 1, Life: 1, Input: core.Input{Fire: true, Aim: core.Vec2{X: 7, Y: 4}}}}); err != nil {
		t.Fatal(err)
	}
	w.Step()
	if b.HP != 100 || len(shotEvents(w)) != 1 || shotEvents(w)[0].Shot.Hit {
		t.Fatal("damage through cover")
	}
}
func TestPlayerContactsUseThreeSecondWindow(t *testing.T) {
	w, a, b := alivePair()
	a.State.X = 4
	b.State.X = 4.4
	b.State.Y = 4
	w.Tick = 359
	w.Step()
	if a.State.X != 4 {
		t.Fatal("contact at exactly 3 seconds")
	}
	w.Step()
	if math.Hypot(a.State.X-b.State.X, a.State.Y-b.State.Y) < .509999 {
		t.Fatal("contact not resolved")
	}
}
func TestCoincidentContactIsFinite(t *testing.T) {
	w, a, b := alivePair()
	b.State = a.State
	w.Tick = 360
	w.Step()
	if math.IsNaN(a.State.X) || math.Hypot(a.State.X-b.State.X, a.State.Y-b.State.Y) < .5 {
		t.Fatal("coincident contact")
	}
}
func TestTeammateContacts(t *testing.T) {
	for _, mode := range []string{ModeTDM, ModeCTF} {
		for _, offset := range []float64{0, .4} {
			t.Run(fmt.Sprintf("%s/offset=%g", mode, offset), func(t *testing.T) {
				w, a, b := alivePair()
				w.Rules.Mode = mode
				a.Team, b.Team = TeamBlue, TeamBlue
				b.State = core.NewPlayer(core.Vec2{X: a.State.X + offset, Y: a.State.Y}, 0)
				w.Tick = 360
				w.Step()
				distance := math.Hypot(a.State.X-b.State.X, a.State.Y-b.State.Y)
				if math.IsNaN(distance) || distance < 2*core.Radius {
					t.Fatalf("teammates overlap: distance=%g", distance)
				}
				if a.HP != 100 || b.HP != 100 {
					t.Fatal("contact damaged teammates")
				}
			})
		}
	}
}
func BenchmarkDuel16(b *testing.B) {
	w := MustNew(arena())
	for i := 0; i < 16; i++ {
		w.Spawn(w.Add())
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		for _, p := range w.Players {
			if p.Status == "dead" {
				w.Spawn(p)
			}
			if err := w.Submit(p, []Command{{Seq: n + 1, Life: p.Life, Input: core.Input{X: 1, Y: -1, Fire: true, Aim: core.Vec2{X: 10, Y: 10}}}}); err != nil {
				b.Fatal(err)
			}
		}
		w.Step()
	}
}

func TestStaleInputsAndLifeCannotResurrectOrOverwriteState(t *testing.T) {
	w, a, _ := alivePair()
	a.Status = "dead"
	a.HP = 0
	a.Died = w.Tick
	for seq := 1; seq <= 30; seq++ {
		if err := w.Submit(a, []Command{{Seq: seq, Life: a.Life, Input: core.Input{X: 1, Fire: true, Aim: core.Vec2{X: 8, Y: 4}}}}); err != nil {
			t.Fatal(err)
		}
		w.Step()
	}
	if a.Status != "dead" || len(a.queue) != 0 || a.Ack != 30 {
		t.Fatal("input resurrected player")
	}
	for i := 0; i < 120; i++ {
		w.Step()
	}
	w.Spawn(a)
	if err := w.Submit(a, []Command{{Seq: 31, Life: 1, Input: core.Input{X: 1, Fire: true, Aim: core.Vec2{X: 8, Y: 4}}}}); err != nil {
		t.Fatal(err)
	}
	before := a.State
	w.Step()
	if a.State.X != before.X || a.State.Y != before.Y || a.State.VX != 0 || a.State.VY != 0 {
		t.Fatal("old life moved new player")
	}
}

func TestStaleLifeAcknowledgmentDoesNotOvertakeQueuedCommands(t *testing.T) {
	w, a, _ := alivePair()
	commands := []Command{{Seq: 1, Life: 1, Input: core.Input{X: 1, Aim: core.Vec2{X: 8, Y: 4}}}, {Seq: 2, Life: 0, Input: core.Input{X: -1, Fire: true, Aim: core.Vec2{X: 8, Y: 4}}}}
	if err := w.Submit(a, commands); err != nil {
		t.Fatal(err)
	}
	if a.Ack != 0 {
		t.Fatal("ack overtook unconsumed input")
	}
	w.Step()
	if a.Ack != 1 || a.State.VX <= 0 {
		t.Fatal("valid input not consumed first")
	}
	w.Step()
	if a.Ack != 2 || a.State.VX < 0 || len(shotEvents(w)) > 0 {
		t.Fatal("stale life executed")
	}
}
