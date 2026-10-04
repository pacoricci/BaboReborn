package match

import (
	"math"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

// Cosmetic collision thresholds in cells/second. Never alter physical response.
const playerContactCueMinSpeed = 2
const itemContactCueMinSpeed = 1

func (w *World) signal(kind string, owner int, position core.Vec3) {
	if kind == "bounce" || kind == "molotov-break" || kind == "shield-hit" {
		w.cue(Cue{Kind: kind, Owner: owner, Position: position})
		return
	}
	w.event(Event{Kind: "signal", Owner: owner, Signal: kind, Position: position})
}

type weaponTransition struct {
	charge     float64
	overheated bool
	reload     int
	protection float64
}

func weaponTransitionBefore(p *core.Player) weaponTransition {
	return weaponTransition{p.Equipment.Charge, p.Equipment.Overheated, reloadStage(p), p.Equipment.Protection}
}

// Cartridge stages describe the existing full-reload interval; they do not change ammunition rules.
func reloadStage(p *core.Player) int {
	if p.Equipment.Primary != "shotgun" || p.Equipment.Shells != gameconfig.ShotgunShells || p.Cooldown <= 1e-9 {
		return -1
	}
	return min(gameconfig.ShotgunShells-1, max(0, int(math.Floor((gameconfig.ShotgunReloadSeconds-p.Cooldown)*float64(gameconfig.ShotgunShells)/gameconfig.ShotgunReloadSeconds))))
}

func (w *World) weaponSignals(p *Player, before weaponTransition) {
	e := p.State.Equipment
	position := core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}
	if e.Primary == "photon" && before.charge == 0 && e.Charge > 0 {
		w.signal("charge", p.ID, position)
	}
	if e.Primary == "chain" && !before.overheated && e.Overheated {
		w.signal("overheat", p.ID, position)
	}
	if before.protection > gameconfig.ShieldInactiveTailSeconds && e.Protection <= gameconfig.ShieldInactiveTailSeconds {
		w.signal("shield-end", p.ID, position)
	}
	if before.overheated && !e.Overheated {
		w.signal("chain-ready", p.ID, position)
	}
	if e.Primary == "photon" && before.charge < gameconfig.PhotonChargeSeconds-1e-9 && e.Charge >= gameconfig.PhotonChargeSeconds-1e-9 {
		w.signal("charge-ready", p.ID, position)
	}
	if stage := reloadStage(&p.State); stage >= 0 && stage != before.reload {
		w.signal("reload", p.ID, position)
	}
}
