package match

import (
	"math"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

func TestMotionAnchorsReconstructGrenadeAndPickupAtEveryAuthorityTick(t *testing.T) {
	w, a, _ := equipPair()
	w.projectile("grenade", a.ID, core.Flight{Position: core.Vec3{X: 4, Y: 4, Z: .3}, Velocity: core.Vec3{X: 5, Y: 1, Z: 5}})
	w.addItem("weapon", "smg", core.Flight{Position: core.Vec3{X: 8, Y: 8, Z: 2}, Velocity: core.Vec3{X: 1, Y: 2, Z: 3}})
	check := func(m core.Motion, f core.Flight) {
		t.Helper()
		predicted := m.Flight
		if w.Tick-m.Tick > MotionAnchorTicks && m.Mode != "fixed" {
			t.Fatal("unbounded anchor age")
		}
		for tick := m.Tick; tick < w.Tick && m.Mode == "bounce"; tick++ {
			core.StepFlight(&predicted, gameconfig.TickSeconds, w.Geometry.Walls, Geometry.WallHeight, true)
		}
		if math.Abs(predicted.Position.X-f.Position.X)+math.Abs(predicted.Position.Y-f.Position.Y)+math.Abs(predicted.Position.Z-f.Position.Z) > 1e-9 {
			t.Fatalf("tick %d: predicted=%+v actual=%+v", w.Tick, predicted, f)
		}
	}
	for range 360 {
		w.Step()
		for _, p := range w.Projectiles {
			check(w.ProjectileMotion(p), p.Flight)
		}
		for _, i := range w.Items {
			check(w.ItemMotion(i), i.Flight)
		}
	}
}
func TestStationaryAndAttachedAnchorsDoNotFollowAuthorityTick(t *testing.T) {
	w, a, b := equipPair()
	p := w.projectile("minibot", a.ID, core.Flight{Position: core.Vec3{X: 4, Y: 4, Z: .15}})
	w.anchorEntities()
	before := p.motion
	for range 20 {
		w.Tick++
		w.anchorEntities()
	}
	if p.motion != before {
		t.Fatal("stationary reference was resent")
	}
	f := w.projectile("flame", a.ID, core.Flight{Position: core.Vec3{X: 5, Y: 5, Z: .2}})
	f.Attached = b.ID
	w.anchorEntities()
	before = f.motion
	w.Tick++
	f.Position.X = 9
	w.anchorEntities()
	if f.motion != before || f.motion.Mode != "attached" {
		t.Fatal("attached position was resent")
	}
	f.Attached = 0
	f.locked = false
	w.anchorEntities()
	if f.motion.Mode != "fall" || f.motion.Tick != w.Tick {
		t.Fatal("detach lacks a new reference")
	}
	w.Match.Phase = "intermission"
	w.anchorEntities()
	if f.motion.Mode != "fixed" {
		t.Fatal("intermission kept extrapolating")
	}
}
