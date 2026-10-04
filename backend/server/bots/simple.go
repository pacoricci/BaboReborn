package bots

import (
	"math"

	"baboreborn/backend/core"
)

// Tuning changes behavior without changing the Brain contract or game rules.
type Tuning struct {
	ReactionSeconds   float64
	MemorySeconds     float64
	AimError          float64
	PreferredDistance float64
	RetreatHP         float64
}

func Standard() Tuning {
	return Tuning{ReactionSeconds: .5, MemorySeconds: 1.5, AimError: .6, PreferredDistance: 6, RetreatHP: 30}
}

type Simple struct {
	visible            bool
	tuning             Tuning
	seed               uint32
	target             int
	seenAt, acquiredAt float64
	lastKnown, patrol  core.Vec2
	hasPatrol          bool
	nextPatrol         float64
	nextUtility        float64
}

func NewSimple(tuning Tuning, seed uint32) *Simple { return &Simple{tuning: tuning, seed: seed} }
func (b *Simple) Reset() {
	b.target = 0
	b.visible = false
	b.hasPatrol = false
	b.seenAt, b.acquiredAt, b.nextPatrol = 0, 0, 0
	b.lastKnown = core.Vec2{}
	b.nextUtility = 0
}
func distance(a, c core.Vec2) float64 { return math.Hypot(a.X-c.X, a.Y-c.Y) }
func (b *Simple) Decide(o Observation, nav Navigator) core.Input {
	pos := core.Vec2{X: o.Self.X, Y: o.Self.Y}
	input := core.Input{Aim: core.Vec2{X: pos.X + math.Cos(o.Self.Angle)*2, Y: pos.Y + math.Sin(o.Self.Angle)*2}}
	var target *Opponent
	for i := range o.Opponents {
		candidate := &o.Opponents[i]
		if candidate.ID == b.target {
			target = candidate
			break
		}
		if target == nil || distance(pos, candidate.Position) < distance(pos, target.Position) {
			target = candidate
		}
	}
	var goal core.Vec2
	if target != nil {
		if target.ID != b.target || !b.visible {
			b.acquiredAt = o.Time
		}
		b.target, b.lastKnown, b.seenAt = target.ID, target.Position, o.Time
		goal = target.Position
		input.Aim = core.Vec2{X: goal.X + (core.NextRandom(&b.seed)*2-1)*b.tuning.AimError, Y: goal.Y + (core.NextRandom(&b.seed)*2-1)*b.tuning.AimError}
		ready := o.Time-b.acquiredAt >= b.tuning.ReactionSeconds
		d := distance(pos, goal)
		preferred := b.preferredDistance(o.Self.Equipment.Primary)
		b.combat(o, d, ready, &input)
		if o.HP <= b.tuning.RetreatHP || d < preferred-1 {
			// Retreat only along a clear segment; otherwise route toward a patrol point.
			if d > .01 {
				away := core.Vec2{X: pos.X + (pos.X-goal.X)/d*3, Y: pos.Y + (pos.Y-goal.Y)/d*3}
				if nav.CanTravel(pos, away) {
					goal = away
				} else {
					goal = b.patrolGoal(o.Time, pos, nav)
				}
			}
		} else if d < preferred+1 {
			// Change strafe direction slowly, instead of jittering every decision.
			side := 1.
			if (int(o.Time/1.5)+b.target)%2 == 0 {
				side = -1
			}
			strafe := core.Vec2{X: pos.X - (goal.Y-pos.Y)/d*side*2, Y: pos.Y + (goal.X-pos.X)/d*side*2}
			if nav.CanTravel(pos, strafe) {
				goal = strafe
			} else {
				goal = pos
			}
		}
	} else if b.target != 0 && o.Time-b.seenAt <= b.tuning.MemorySeconds && distance(pos, b.lastKnown) > .5 {
		goal = b.lastKnown
		input.Aim = b.lastKnown
	} else {
		b.target = 0
		goal = b.patrolGoal(o.Time, pos, nav)
	}
	// Keep fighting visible enemies while moving toward the flag objective.
	if o.Objective != nil {
		goal = *o.Objective
	}
	if point, ok := nav.Waypoint(pos, goal); ok {
		dx, dy := point.X-pos.X, point.Y-pos.Y
		d := math.Hypot(dx, dy)
		if d > .15 {
			input.X, input.Y = dx/d, dy/d
		}
		if target == nil {
			input.Aim = point
		}
	}
	b.visible = target != nil
	return input
}
func (b *Simple) patrolGoal(now float64, pos core.Vec2, nav Navigator) core.Vec2 {
	if !b.hasPatrol || distance(pos, b.patrol) < .7 || now >= b.nextPatrol {
		b.patrol = nav.PatrolPoint(core.NextRandom(&b.seed))
		b.hasPatrol = true
		b.nextPatrol = now + 8
	}
	return b.patrol
}
