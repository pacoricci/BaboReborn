package match

import (
	"testing"

	"baboreborn/backend/core"
)

func shotEvents(w *World) []Cue   { return cuesOf(w, "shot") }
func effectEvents(w *World) []Cue { return cuesOf(w, "explosion", "rocket-explosion", "knives") }
func cuesOf(w *World, kinds ...string) []Cue {
	var out []Cue
	for _, c := range w.Cues {
		for _, kind := range kinds {
			if c.Kind == kind {
				out = append(out, c)
			}
		}
	}
	return out
}
func hasHit(w *World) bool {
	for _, e := range w.Events {
		if e.Kind == "hit" {
			return true
		}
	}
	return false
}
func signalEvents(w *World) []Cue {
	out := cuesOf(w, "bounce", "molotov-break", "shield-hit")
	for _, e := range w.Events {
		if e.Kind == "signal" {
			out = append(out, Cue{ID: e.ID, Kind: e.Signal, Tick: e.Tick, Round: e.Round, Owner: e.Owner, Position: e.Position})
		}
	}
	return out
}

func TestDamageFactsSurviveHealingAndDeathIsEmittedOnce(t *testing.T) {
	w, a, b := equipPair()
	w.DrainEvents()
	b.body.HP = 70
	w.resolveDeaths(a.ID, "smg")
	b.HP, b.body.HP = 100, 100
	w.resolveDeaths(a.ID, "smg")
	if len(w.Events) != 1 || w.Events[0].Kind != "damage" || w.Events[0].Amount != 30 || w.Events[0].Owner != b.ID {
		t.Fatal(w.Events)
	}
	b.body.HP = -20
	w.resolveDeaths(999, "grenade")
	w.resolveDeaths(999, "grenade")
	if len(w.Events) != 3 || w.Events[1].Amount != 100 || w.Events[2].Kind != "death" || w.Events[2].Life != b.Life {
		t.Fatal(w.Events)
	}
}

func TestRequiredFactsSurviveRoundChangeAndVisualOverflow(t *testing.T) {
	w, a, _ := equipPair()
	w.DrainEvents()
	w.emitShot(a.ID, &core.Shot{Pellets: []*core.Shot{{Hit: true}, {Hit: true}}})
	cut := w.EventCut()
	if len(w.Events) != 1 || w.Events[0].Kind != "hit" || w.Events[0].Action != w.Cues[0].ID {
		t.Fatal(w.Events)
	}
	for range 200 {
		w.signal("bounce", a.ID, core.Vec3{})
	}
	w.Match.Phase, w.Match.Ends = "intermission", w.Tick
	w.advanceMatch()
	if w.Events[0].ID != cut || w.Events[0].Round != 1 || w.Events[1].Kind != "phase" || w.Events[1].Round != 2 {
		t.Fatal(w.Events)
	}
	w.DrainEvents()
	if len(w.Events) != 0 || len(w.Cues) != 0 || w.EventFrom() != w.EventCut() {
		t.Fatal("drain did not transfer boundary")
	}
}

func TestProjectileHitKeepsTheLifeThatCreatedIt(t *testing.T) {
	w, a, b := equipPair()
	w.DrainEvents()
	p := w.projectile("grenade", a.ID, core.Flight{Position: core.Vec3{X: b.State.X, Y: b.State.Y, Z: core.Radius}})
	life := a.Life
	a.Life++
	p.Expires = w.Tick
	w.updateEntities()
	for _, event := range w.Events {
		if event.Kind == "hit" {
			if event.Owner != a.ID || event.Life != life {
				t.Fatal(event)
			}
			return
		}
	}
	t.Fatal("grenade fixture did not hit")
}
