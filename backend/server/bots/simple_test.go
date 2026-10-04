package bots

import (
	"reflect"
	"testing"

	"baboreborn/backend/core"
)

type openNavigation struct{}

func (openNavigation) Waypoint(_, to core.Vec2) (core.Vec2, bool) { return to, true }
func (openNavigation) CanTravel(_, _ core.Vec2) bool              { return true }
func (openNavigation) PatrolPoint(_ float64) core.Vec2            { return core.Vec2{X: 12, Y: 12} }

func TestReactionLostSightMemoryAndReset(t *testing.T) {
	b := NewSimple(Standard(), 1)
	o := Observation{Time: 1, HP: 100, Self: core.NewPlayer(core.Vec2{X: 2, Y: 2}, 0), Opponents: []Opponent{{ID: 2, Position: core.Vec2{X: 10, Y: 2}}}}
	if b.Decide(o, openNavigation{}).Fire {
		t.Fatal("instant reaction")
	}
	o.Time = 1.6
	o.Self.Equipment.Grenades = 0
	if !b.Decide(o, openNavigation{}).Fire {
		t.Fatal("never engages")
	}
	o.Opponents = nil
	o.Time = 1.7
	input := b.Decide(o, openNavigation{})
	if input.Fire || input.Secondary || input.Grenade || input.Molotov || input.X <= 0 || input.Y != 0 {
		t.Fatal("must search last visible position without firing", input)
	}
	o.Time = 5
	input = b.Decide(o, openNavigation{})
	if input.Fire || input.Y <= 0 {
		t.Fatal("must abandon stale target and patrol", input)
	}
	b.Reset()
	o.Opponents = []Opponent{{ID: 2, Position: core.Vec2{X: 10, Y: 2}}}
	if b.Decide(o, openNavigation{}).Fire {
		t.Fatal("respawn retained combat memory")
	}
}
func TestDeterministicReplayAndRetreat(t *testing.T) {
	a, b := NewSimple(Standard(), 77), NewSimple(Standard(), 77)
	o := Observation{HP: 20, Self: core.NewPlayer(core.Vec2{X: 8, Y: 8}, 0), Opponents: []Opponent{{ID: 3, Position: core.Vec2{X: 12, Y: 8}}}}
	for i := 0; i < 100; i++ {
		o.Time = float64(i) / 10
		x, y := a.Decide(o, openNavigation{}), b.Decide(o, openNavigation{})
		if !reflect.DeepEqual(x, y) {
			t.Fatal("same seed did not replay")
		}
		if x.X >= 0 {
			t.Fatal("injured bot did not retreat", x)
		}
		if x.Aim == o.Opponents[0].Position {
			t.Fatal("aim has no error")
		}
	}
}

func TestReacquisitionRestartsReaction(t *testing.T) {
	b := NewSimple(Standard(), 1)
	o := Observation{Time: 1, HP: 40, Self: core.NewPlayer(core.Vec2{}, 0), Opponents: []Opponent{{ID: 2, Position: core.Vec2{X: .5}}}}
	b.Decide(o, openNavigation{})
	o.Time = 1.6
	b.Decide(o, openNavigation{})
	rivals := o.Opponents
	o.Opponents = nil
	o.Time = 1.7
	b.Decide(o, openNavigation{})
	o.Opponents = rivals
	o.Time = 1.8
	input := b.Decide(o, openNavigation{})
	if input.Fire || input.Secondary || input.Grenade || input.Molotov {
		t.Fatal("reacquisition bypassed reaction", input)
	}
}
