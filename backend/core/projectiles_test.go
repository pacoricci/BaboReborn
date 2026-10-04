package core

import (
	"math"
	"testing"
)

func TestGrenadeReflectsEachWallFaceWithSourceRestitution(t *testing.T) {
	for _, c := range []struct{ from, velocity, normal Vec3 }{
		{Vec3{X: 4.99, Y: 5.5, Z: 1.2}, Vec3{X: 5, Y: 1, Z: 2}, Vec3{X: -1}},
		{Vec3{X: 6.01, Y: 5.5, Z: 1.2}, Vec3{X: -5, Y: 1, Z: 2}, Vec3{X: 1}},
		{Vec3{X: 5.5, Y: 4.99, Z: 1.2}, Vec3{X: 1, Y: 5, Z: 2}, Vec3{Y: -1}},
		{Vec3{X: 5.5, Y: 6.01, Z: 1.2}, Vec3{X: 1, Y: -5, Z: 2}, Vec3{Y: 1}},
	} {
		f := Flight{Position: c.from, Velocity: c.velocity}
		n := StepFlight(&f, 1./120, []Wall{{X: 5, Y: 5, W: 1, H: 1, Height: 3}}, .7, true)
		if n == nil || *n != c.normal {
			t.Fatalf("face normal: %v, want %v", n, c.normal)
		}
		v := c.velocity
		v.Z -= 9.8 / 120
		dot := v.X*c.normal.X + v.Y*c.normal.Y + v.Z*c.normal.Z
		want := Vec3{(v.X - 2*dot*c.normal.X) * .65, (v.Y - 2*dot*c.normal.Y) * .65, (v.Z - 2*dot*c.normal.Z) * .65}
		if math.Abs(f.Velocity.X-want.X)+math.Abs(f.Velocity.Y-want.Y)+math.Abs(f.Velocity.Z-want.Z) > 1e-12 {
			t.Fatal(f.Velocity, want)
		}
		// The separation offset must leave the solid, so subsequent flight does not freeze.
		before := f.Position
		StepFlight(&f, 1./120, []Wall{{X: 5, Y: 5, W: 1, H: 1, Height: 3}}, .7, true)
		if f.Position == before {
			t.Fatal("projectile stuck after rebound")
		}
	}
}
func TestGrenadeClearsLowCoverButNotTallBoundary(t *testing.T) {
	for _, height := range []float64{1, 3} {
		f := Flight{Position: Vec3{X: 4, Y: 4, Z: .21839080810546876}, Velocity: Vec3{X: 5, Z: 5}}
		walls := []Wall{{X: 6, Y: 3, W: 1, H: 3, Height: height}}
		bounced := false
		for tick := 0; tick < 60; tick++ {
			if n := StepFlight(&f, 1./120, walls, .7, true); n != nil && n.X != 0 {
				bounced = true
			}
		}
		if bounced != (height == 3) {
			t.Fatalf("height %v: side bounce %v", height, bounced)
		}
	}
}
func TestAreaFalloffHeightOcclusionAndRange(t *testing.T) {
	source := Vec3{X: 4, Y: 4, Z: .25}
	body := Body{X: 5.5, Y: 4, Radius: .25}
	if got := AreaDamage(source, 3, 150, false, &body, nil, .7); got != 75 {
		t.Fatal(got)
	}
	walls := []Wall{{X: 5, Y: 3, W: 1, H: 3, Height: 3}}
	if got := AreaDamage(source, 3, 150, false, &body, walls, .7); got != 0 {
		t.Fatal("damage through wall", got)
	}
	body.X = 7
	if AreaDamage(source, 3, 150, false, &body, nil, .7) != 0 {
		t.Fatal("inclusive radius")
	}
}
