// Portions adapted from BaboViolent 2, src/Game/MapRender.cpp.
// Copyright 2012 bitHeads inc.
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted for BaboReborn; see CREDITS.md and
// frontend/public/licenses/BaboViolent2.txt for provenance and the original notice.

package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

type Grid struct {
	Wall
	Cells []bool
}

func NewGrid(bounds Wall, walls []Wall) Grid {
	integer := func(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v == math.Trunc(v) }
	if !integer(bounds.X) || !integer(bounds.Y) || !integer(bounds.W) || !integer(bounds.H) || bounds.W < 3 || bounds.H < 3 {
		panic("invalid grid bounds")
	}
	g := Grid{bounds, make([]bool, int(bounds.W*bounds.H))}
	for _, w := range walls {
		if !integer(w.X) || !integer(w.Y) || !integer(w.W) || !integer(w.H) || w.W <= 0 || w.H <= 0 || w.X < bounds.X || w.Y < bounds.Y || w.X+w.W > bounds.X+bounds.W || w.Y+w.H > bounds.Y+bounds.H {
			panic("invalid grid wall")
		}
		for y := int(w.Y - bounds.Y); y < int(w.Y-bounds.Y+w.H); y++ {
			for x := int(w.X - bounds.X); x < int(w.X-bounds.X+w.W); x++ {
				g.Cells[y*int(bounds.W)+x] = true
			}
		}
	}
	return g
}
func (g Grid) solid(x, y int) bool {
	return x < 0 || y < 0 || x >= int(g.W) || y >= int(g.H) || g.Cells[y*int(g.W)+x]
}
func ResolveGrid(p *Player, oldX, oldY float64, g Grid) {
	column, row := int(Clamp(math.Trunc(p.X-g.X), 1, g.W-2)), int(Clamp(math.Trunc(p.Y-g.Y), 1, g.H-2))
	margin := Radius + Clearance
	for axis := 0; axis < 2; axis++ {
		vertical := axis == 0
		vel, acrossOld := p.VX, oldY
		if vertical {
			vel, acrossOld = p.VY, oldX
		}
		if vel == 0 {
			continue
		}
		dir := 1
		if vel < 0 {
			dir = -1
		}
		for _, offset := range []int{0, -1, 1} {
			x, y := column+dir, row+offset
			if vertical {
				x, y = column+offset, row+dir
			}
			if !g.solid(x, y) {
				continue
			}
			across, along, position := g.Y+float64(y), g.X+float64(x), p.X
			if vertical {
				across, along, position = g.X+float64(x), g.Y+float64(y), p.Y
			}
			if acrossOld-Radius > across+1 || acrossOld+Radius < across || position-Radius > along+1 || position+Radius < along {
				continue
			}
			separated := along - margin
			if dir < 0 {
				separated = along + 1 + margin
			}
			if vertical {
				p.Y = separated
				p.VY = -p.VY * Bounce
			} else {
				p.X = separated
				p.VX = -p.VX * Bounce
			}
		}
	}
	x, y := int(p.X-g.X), int(p.Y-g.Y)
	left, bottom := g.X+float64(x), g.Y+float64(y)
	if p.X+margin > left+1 && g.solid(x+1, y) {
		p.X = left + 1 - margin
	}
	if p.X-margin < left && g.solid(x-1, y) {
		p.X = left + margin
	}
	if p.Y+margin > bottom+1 && g.solid(x, y+1) {
		p.Y = bottom + 1 - margin
	}
	if p.Y-margin < bottom && g.solid(x, y-1) {
		p.Y = bottom + margin
	}
	if x <= 0 {
		p.X = g.X + 1 + margin
	}
	if x >= int(g.W)-1 {
		p.X = g.X + g.W - 1 - margin
	}
	if y <= 0 {
		p.Y = g.Y + 1 + margin
	}
	if y >= int(g.H)-1 {
		p.Y = g.Y + g.H - 1 - margin
	}
	if x < 0 || y < 0 || x >= int(g.W) || y >= int(g.H) || !g.solid(x, y) {
		return
	}
	dx, dy, nearest := p.X-left, p.Y-bottom, 2.
	if !g.solid(x-1, y) && dx < nearest {
		p.X = left - margin
		nearest = dx
	}
	if !g.solid(x+1, y) && 1-dx < nearest {
		p.X = left + 1 + margin
		nearest = 1 - dx
	}
	if !g.solid(x, y-1) && dy < nearest {
		p.Y = bottom - margin
		nearest = dy
	}
	if !g.solid(x, y+1) && 1-dy < nearest {
		p.Y = bottom + 1 + margin
	}
}

// ResolveContact follows Game.cpp's local-player response, now ordered by server ID.
// Exactly coincident centers use a deterministic axis; the reference normalization is undefined there.
func ResolveContact(p *Player, other Vec2, grid Grid, direction float64) bool {
	dx, dy := other.X-p.X, other.Y-p.Y
	d := math.Hypot(dx, dy)
	if d > 2*Radius {
		return false
	}
	oldX, oldY := p.X, p.Y
	if d < 1e-12 {
		dx, dy, d = direction, 0, 1
	}
	p.X = other.X - dx/d*(2*Radius+gameconfig.MovementContactGap)
	p.Y = other.Y - dy/d*(2*Radius+gameconfig.MovementContactGap)
	p.VX = -p.VX * Bounce
	p.VY = -p.VY * Bounce
	ResolveGrid(p, oldX, oldY, grid)
	return true
}
