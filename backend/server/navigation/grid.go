// Package navigation provides static-map routing independently of bot tactics.
package navigation

import (
	"math"

	"baboreborn/backend/core"
)

// Grid owns copied map data and reusable BFS scratch space. Use on one goroutine.
// Cell-centre routes leave clearance for ordinary players; no diagonal corner cuts.
type Grid struct {
	grid           core.Grid
	points         []core.Vec2
	parents, queue []int
}

func New(g core.Grid) *Grid {
	g.Cells = append([]bool(nil), g.Cells...)
	n := &Grid{grid: g, parents: make([]int, len(g.Cells)), queue: make([]int, 0, len(g.Cells))}
	for i := range g.Cells {
		if n.open(i%int(g.W), i/int(g.W)) {
			n.points = append(n.points, n.center(i))
		}
	}
	return n
}
func (n *Grid) open(x, y int) bool {
	g := n.grid
	return x > 0 && y > 0 && x < int(g.W)-1 && y < int(g.H)-1 && !g.Cells[y*int(g.W)+x]
}
func (n *Grid) center(i int) core.Vec2 {
	return core.Vec2{X: n.grid.X + float64(i%int(n.grid.W)) + .5, Y: n.grid.Y + float64(i/int(n.grid.W)) + .5}
}
func (n *Grid) cell(p core.Vec2) (int, bool) {
	x, y := int(math.Floor(p.X-n.grid.X)), int(math.Floor(p.Y-n.grid.Y))
	return y*int(n.grid.W) + x, n.open(x, y)
}
func (n *Grid) PatrolPoint(choice float64) core.Vec2 {
	if len(n.points) == 0 {
		return core.Vec2{}
	}
	return n.points[int(core.Clamp(choice, 0, .999999999)*float64(len(n.points)))]
}
func (n *Grid) CanTravel(from, to core.Vec2) bool {
	if _, ok := n.cell(from); !ok {
		return false
	}
	if _, ok := n.cell(to); !ok {
		return false
	}
	// Exact segment versus expanded solid cells avoids missed corners between samples.
	// A position separated by ResolveGrid may touch this exact clearance edge.
	// Permit motion away from it; do not classify touching as starting inside a wall.
	margin := core.Radius + core.Clearance - 1e-6
	minX := int(math.Floor(math.Min(from.X, to.X) - n.grid.X - margin))
	maxX := int(math.Floor(math.Max(from.X, to.X) - n.grid.X + margin))
	minY := int(math.Floor(math.Min(from.Y, to.Y) - n.grid.Y - margin))
	maxY := int(math.Floor(math.Max(from.Y, to.Y) - n.grid.Y + margin))
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			if n.open(x, y) {
				continue
			}
			left, bottom := n.grid.X+float64(x)-margin, n.grid.Y+float64(y)-margin
			if intersects(from, to, left, bottom, left+1+2*margin, bottom+1+2*margin) {
				return false
			}
		}
	}
	return true
}
func intersects(a, b core.Vec2, left, bottom, right, top float64) bool {
	lo, hi := 0., 1.
	for _, axis := range [][4]float64{{a.X, b.X - a.X, left, right}, {a.Y, b.Y - a.Y, bottom, top}} {
		if math.Abs(axis[1]) < 1e-12 {
			if axis[0] < axis[2] || axis[0] > axis[3] {
				return false
			}
			continue
		}
		u, v := (axis[2]-axis[0])/axis[1], (axis[3]-axis[0])/axis[1]
		if u > v {
			u, v = v, u
		}
		lo, hi = math.Max(lo, u), math.Min(hi, v)
		if lo > hi {
			return false
		}
	}
	return true
}
func (n *Grid) Waypoint(from, to core.Vec2) (core.Vec2, bool) {
	start, ok := n.cell(from)
	if !ok {
		return core.Vec2{}, false
	}
	end, ok := n.cell(to)
	if !ok {
		return core.Vec2{}, false
	}
	if n.CanTravel(from, to) {
		return to, true
	}
	for i := range n.parents {
		n.parents[i] = -1
	}
	n.queue = append(n.queue[:0], start)
	n.parents[start] = start
	for head := 0; head < len(n.queue) && n.parents[end] < 0; head++ {
		cur := n.queue[head]
		x, y := cur%int(n.grid.W), cur/int(n.grid.W)
		for _, d := range [][2]int{{1, 0}, {0, 1}, {-1, 0}, {0, -1}} {
			nx, ny := x+d[0], y+d[1]
			i := ny*int(n.grid.W) + nx
			if n.open(nx, ny) && n.parents[i] < 0 {
				n.parents[i] = cur
				n.queue = append(n.queue, i)
			}
		}
	}
	if n.parents[end] < 0 {
		return core.Vec2{}, false
	}
	// Walk backwards to the furthest safe point reachable from the actual position.
	for cur := end; cur != start; cur = n.parents[cur] {
		p := n.center(cur)
		if n.CanTravel(from, p) {
			return p, true
		}
	}
	p := n.center(start)
	return p, n.CanTravel(from, p)
}
