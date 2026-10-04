package bots

import (
	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

func (b *Simple) preferredDistance(primary string) float64 {
	switch primary {
	case "shotgun", "flamethrower":
		return 3
	case "sniper", "bazooka":
		return 7
	case "dual", "photon":
		return 5
	default:
		return b.tuning.PreferredDistance
	}
}

func (b *Simple) combat(o Observation, d float64, ready bool, input *core.Input) {
	if !ready {
		return
	}
	e := o.Self.Equipment
	input.Fire = true
	switch e.Primary {
	case "bazooka":
		// Let the rocket reach its target; held fire would remotely explode it early.
		input.Fire = !e.RocketActive && d > gameconfig.BazookaRadius+2
	case "flamethrower":
		// Release long enough to restore range rather than holding a one-cell flame.
		input.Fire = d < gameconfig.FlamethrowerMaxRange && (e.FireTime < .7 || e.SinceShot > .3)
	}
	if o.Time < b.nextUtility || e.MeleeDelay > 0 || e.ThrowDelay > 0 {
		return
	}
	switch e.Secondary {
	case "knives":
		input.Secondary = d < .9
	case "shield":
		input.Secondary = o.HP < 60 && d < 6
	case "minibot":
		input.Secondary = d < gameconfig.MinibotRadius
	}
	if input.Secondary {
		input.Fire = false
		b.nextUtility = o.Time + 5
		return
	}
	// These are conservative tactical bands, not a ballistic hit prediction.
	grenade := e.Grenades > 0 && d >= 5 && d <= 8
	molotov := e.Molotovs > 0 && d >= 3 && d < 5
	if !grenade && !molotov {
		return
	}
	// Primary fire runs first in mechanics: release it and wait for its cooldown
	// before pulsing a throw, otherwise fast guns indefinitely starve throwables.
	input.Fire = false
	if o.Self.Cooldown > 1e-9 {
		return
	}
	input.Grenade, input.Molotov = grenade, molotov
	b.nextUtility = o.Time + 3
}
