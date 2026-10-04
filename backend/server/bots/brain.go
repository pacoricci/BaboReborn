// Package bots defines the replaceable decision module. It cannot access the match.
package bots

import "baboreborn/backend/core"

// Observation contains owned values, never pointers into authoritative state.
// Opponents contains only currently visible living rivals, whether human or bot.
type Observation struct {
	Objective *core.Vec2
	Time      float64
	Self      core.Player
	HP        float64
	Opponents []Opponent
}
type Opponent struct {
	ID       int
	Position core.Vec2
}

// Navigator exposes static geometry queries, not player locations or match state.
// Waypoint returns a reachable next point, or false when no route exists.
type Navigator interface {
	Waypoint(from, to core.Vec2) (core.Vec2, bool)
	CanTravel(from, to core.Vec2) bool
	PatrolPoint(choice float64) core.Vec2
}

// Brain owns per-bot memory. Reset is called on each new life, including rounds.
// Decide runs on the authority goroutine and must return promptly. Actions pass
// through ordinary input validation and mechanics; this is not a plugin sandbox.
type Brain interface {
	Reset()
	Decide(Observation, Navigator) core.Input
}
