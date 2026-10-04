package core

import (
	"math"
	"testing"
)

func TestFiniteSegmentsWallTopAndSphere(t *testing.T) {
	walls := []Wall{{X: 5, Y: 3, W: 1, H: 3}}
	point, n := MapImpact(Vec3{X: 4, Y: 4, Z: .25}, Vec3{X: 8, Y: 4, Z: .25}, walls, .7)
	if point.X != 5 || n == nil || n.X != -1 {
		t.Fatal(point, n)
	}
	point, _ = MapImpact(Vec3{X: 4, Y: 4, Z: 1}, Vec3{X: 8, Y: 4, Z: 1}, walls, .7)
	if point.X != 8 {
		t.Fatal("high shot blocked")
	}
	point, n = MapImpact(Vec3{X: 5.5, Y: 4, Z: 1}, Vec3{X: 5.5, Y: 4, Z: .1}, walls, .7)
	if math.Abs(point.Z-.7) > 1e-12 || n.Z != 1 {
		t.Fatal("top intersection")
	}
	p := SphereImpact(Vec3{X: 4, Y: 4, Z: .25}, Vec3{X: 8, Y: 4, Z: .25}, Vec3{X: 6, Y: 4, Z: .25}, .25)
	if p == nil || p.X != 6 {
		t.Fatal("not closest point")
	}
	if SphereImpact(Vec3{X: 4, Y: 4, Z: .25}, Vec3{X: 5, Y: 4, Z: .25}, Vec3{X: 6, Y: 4, Z: .25}, .25) != nil {
		t.Fatal("infinite ray")
	}
}
func TestNearestVictimAndSpawnImmunityBlockFurtherHits(t *testing.T) {
	p := NewPlayer(Vec2{4, 4}, 0)
	p.Cooldown = 0
	seed := uint32(7291)
	near := &Body{ID: 2, X: 6, Y: 4, Radius: .25, HP: 100, Immune: true}
	far := &Body{ID: 3, X: 7, Y: 4, Radius: .25, HP: 100}
	g := ShotGeometry{MuzzleHeight: .25, MaxDistance: 128, WallHeight: .7}
	world := World{Grid: NewGrid(Wall{W: 20, H: 20}, nil)}
	shot := Step(&p, Input{Aim: Vec2{7, 4}, Fire: true}, 1./120, world, []*Body{far, near}, &seed, g)
	if shot == nil || shot.TargetID == nil || *shot.TargetID != 2 || near.HP != 100 || far.HP != 100 {
		t.Fatal("immune nearest body did not block", shot)
	}
}
