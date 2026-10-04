package navigation

import (
	"math"
	"testing"

	"baboreborn/backend/core"
)

func TestRouteAroundWallWithPlayerClearance(t *testing.T) {
	n := New(core.NewGrid(core.Wall{W: 12, H: 12}, []core.Wall{{X: 5, Y: 1, W: 1, H: 7}}))
	pos, goal := core.Vec2{X: 3.5, Y: 3.5}, core.Vec2{X: 8.5, Y: 3.5}
	if n.CanTravel(pos, goal) {
		t.Fatal("wall ignored")
	}
	for step := 0; step < 150 && math.Hypot(pos.X-goal.X, pos.Y-goal.Y) > .1; step++ {
		next, ok := n.Waypoint(pos, goal)
		if !ok || !n.CanTravel(pos, next) {
			t.Fatal("route crosses wall or is missing", pos, next)
		}
		d := math.Hypot(next.X-pos.X, next.Y-pos.Y)
		if d < .01 {
			t.Fatal("stuck", pos)
		}
		f := math.Min(.2/d, 1)
		pos.X += (next.X - pos.X) * f
		pos.Y += (next.Y - pos.Y) * f
	}
	if math.Hypot(pos.X-goal.X, pos.Y-goal.Y) > .1 {
		t.Fatal("failed to reach goal", pos)
	}
	if n.CanTravel(core.Vec2{X: 4.5, Y: 2}, core.Vec2{X: 4.8, Y: 2}) {
		t.Fatal("player clearance ignored")
	}
}
func TestCanLeaveCollisionClearanceBoundary(t *testing.T) {
	n := New(core.NewGrid(core.Wall{W: 12, H: 12}, []core.Wall{{X: 5, Y: 1, W: 1, H: 7}}))
	from := core.Vec2{X: 5 - core.Radius - core.Clearance, Y: 3}
	if !n.CanTravel(from, core.Vec2{X: 4, Y: 3}) {
		t.Fatal("collision clearance position cannot move away from wall")
	}
	if n.CanTravel(from, core.Vec2{X: 4.9, Y: 3}) {
		t.Fatal("can move toward solid wall")
	}
}
func TestUnreachableAndIndependentGeometry(t *testing.T) {
	g := core.NewGrid(core.Wall{W: 10, H: 10}, []core.Wall{{X: 5, Y: 0, W: 1, H: 10}})
	n := New(g)
	clear(g.Cells)
	if _, ok := n.Waypoint(core.Vec2{X: 2.5, Y: 2.5}, core.Vec2{X: 7.5, Y: 2.5}); ok {
		t.Fatal("unreachable destination or shared mutable geometry")
	}
}
