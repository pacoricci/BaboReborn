package match

import (
	"errors"
	"fmt"
	"math"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/bots"
)

const BotDecisionTicks = gameconfig.TickHz / 10
const botSightRange = 8.

type botController struct {
	brain              bots.Brain
	navigation         bots.Navigator
	life, nextDecision int
	input              core.Input
}

// AddBot is a composition-time operation, or must run on the world's owner.
// A bot occupies an ordinary player slot. The caller owns server capacity policy.
func (w *World) AddBot(brain bots.Brain, navigation bots.Navigator) (*Player, error) {
	if len(w.rotation) > 0 {
		navigation = w.rotation[(w.Match.Round-1)%len(w.rotation)].navigation
	}
	if brain == nil || navigation == nil {
		return nil, errors.New("bot needs a brain and navigation")
	}
	if len(w.Players) >= MaxPlayers {
		return nil, errors.New("player capacity reached")
	}
	p := w.Add()
	p.Nickname = fmt.Sprintf("▣ Bot %02d", p.ID)
	colors := []string{"#ef6548", "#52c7aa", "#e6b94c", "#ad87eb"}
	p.NextAppearance = Appearance{Template: "bands", Colors: []string{colors[(p.ID-1)%len(colors)], "#202838", "#e8e6d9"}}
	p.bot = &botController{brain: brain, navigation: navigation}
	return p, nil
}

// Perception is sampled before any actor moves this tick. Only copied visible
// positions cross the brain boundary; no hidden HP, inputs, seed or live pointers.
func (w *World) observeBot(p *Player) bots.Observation {
	opponents := make([]bots.Opponent, 0, MaxPlayers-1)
	from := core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}
	for _, other := range w.Players {
		if !w.enemies(p, other) || other.Status != "alive" {
			continue
		}
		if math.Hypot(other.State.X-from.X, other.State.Y-from.Y) > botSightRange {
			continue
		}
		to := core.Vec3{X: other.State.X, Y: other.State.Y, Z: core.Radius}
		if _, normal := core.MapImpact(from, to, w.Geometry.Walls, Geometry.WallHeight); normal != nil {
			continue
		}
		opponents = append(opponents, bots.Opponent{ID: other.ID, Position: core.Vec2{X: to.X, Y: to.Y}})
	}
	return bots.Observation{Objective: w.botObjective(p), Time: float64(w.Tick) * gameconfig.TickSeconds, Self: p.State, HP: p.HP, Opponents: opponents}
}
func (w *World) prepareBots() {
	// Spawn all eligible bots before perception, preserving the ordinary spawn rule.
	for _, p := range w.Players {
		if p.bot != nil && p.Status != "alive" {
			w.Spawn(p)
		}
	}
	for _, p := range w.Players {
		b := p.bot
		if b == nil || p.Status != "alive" {
			continue
		}
		if b.life != p.Life {
			b.brain.Reset()
			b.life = p.Life
			b.nextDecision = w.Tick
			b.input = core.Input{}
		}
		if w.Tick >= b.nextDecision {
			b.input = b.brain.Decide(w.observeBot(p), b.navigation)
			b.nextDecision = w.Tick + BotDecisionTicks
		}
		// Same validated command queue as humans, one command per simulation tick.
		if err := w.Submit(p, []Command{{Seq: p.accepted + 1, Life: p.Life, Input: b.input}}); err != nil {
			// A faulty replacement must not poison the authoritative simulation.
			w.Release(p)
			b.input = core.Input{Aim: core.Vec2{X: p.State.X + 2, Y: p.State.Y}}
		}
		// Discrete actions are pulses; movement, aim and primary fire are held.
		b.input.Secondary = false
		b.input.Grenade = false
		b.input.Molotov = false
		b.input.Pickup = 0
	}
}

// Different starting slots and life rotation expose the full arsenal even in small rooms.
func botLoadout(id, completedLives int) (string, string) {
	primaries := [...]string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"}
	secondaries := [...]string{"knives", "shield", "minibot"}
	index := id - 1 + completedLives
	return primaries[index%len(primaries)], secondaries[(index+completedLives/len(primaries))%len(secondaries)]
}
