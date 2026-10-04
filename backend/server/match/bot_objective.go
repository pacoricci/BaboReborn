package match

import "baboreborn/backend/core"

// Objectives are public flag information, never hidden opponents. Carriers and
// alternating defenders recover their flag; remaining bots attack the enemy flag.
func (w *World) botObjective(p *Player) *core.Vec2 {
	if w.Rules.Mode != ModeCTF {
		return nil
	}
	var own, enemy Flag
	for _, f := range w.Flags {
		if f.Team == p.Team {
			own = f
		} else {
			enemy = f
		}
	}
	goal := enemy.Position
	if enemy.Carrier == p.ID {
		goal = w.teamBase(p.Team).Base
		if own.State != "home" {
			goal = own.Position
		}
	} else if own.State != "home" && p.ID%2 == 0 {
		goal = own.Position
	} else if enemy.Carrier != 0 {
		goal = w.teamBase(p.Team).Base
	}
	return &goal
}
