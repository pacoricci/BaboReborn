package match

import (
	"fmt"
	"math"

	"baboreborn/backend/core"
	"baboreborn/backend/maps"
)

const ModeDM = "dm"
const ModeTDM = "tdm"
const ModeCTF = "ctf"

func ValidMode(mode string) bool { return mode == ModeDM || mode == ModeTDM || mode == ModeCTF }
func (w *World) teamMode() bool  { return w.Rules.Mode == ModeTDM || w.Rules.Mode == ModeCTF }
func (w *World) enemies(a, b *Player) bool {
	return a != nil && b != nil && a.ID != b.ID && (!w.teamMode() || a.Team != b.Team)
}
func (w *World) canDamage(owner int, target *Player) bool {
	attacker := w.Find(owner)
	return attacker != nil && (owner == target.ID || w.enemies(attacker, target))
}

// Assign only on first participation; respawns and map changes preserve the team.
// Spectators do not reserve a team slot, and no live player is forcibly transferred.
func (w *World) assignTeam(p *Player) {
	if !w.teamMode() {
		p.Team = TeamNone
		return
	}
	if p.Team != TeamNone {
		return
	}
	blue, red := 0, 0
	for _, other := range w.Players {
		if other.Team == TeamBlue {
			blue++
		}
		if other.Team == TeamRed {
			red++
		}
	}
	p.Team = TeamBlue
	if red < blue {
		p.Team = TeamRed
	}
}
func (w *World) teamBase(team Team) maps.TeamBase {
	if team == TeamBlue {
		return w.Arena.Teams.Blue
	}
	return w.Arena.Teams.Red
}
func (w *World) spawnPoints(p *Player) []core.Vec2 {
	if w.teamMode() && w.Arena.Teams != nil {
		return w.teamBase(p.Team).Spawns
	}
	return w.Arena.Spawns
}
func (w *World) validateMode(mode string) error {
	if mode != ModeCTF {
		return nil
	}
	if w.Arena.Teams == nil {
		return fmt.Errorf("CTF requires a map with bases and team spawns")
	}
	for _, m := range w.rotation {
		if m.arena.Teams == nil {
			return fmt.Errorf("CTF map %q has no team layout", m.arena.ID)
		}
	}
	return nil
}

type TeamScores struct {
	Blue int
	Red  int
}

func (w *World) teamPoint(team Team, amount int) {
	if team == TeamBlue {
		w.Match.Scores.Blue += amount
	}
	if team == TeamRed {
		w.Match.Scores.Red += amount
	}
}
func (w *World) scoreKill(killer, victim *Player) {
	delta := 1
	if killer.ID == victim.ID {
		delta = -1
	}
	killer.Kills += delta
	if w.Rules.Mode == ModeCTF {
		return
	} // Captures alone award CTF points.
	killer.Score += delta
	if w.Rules.Mode == ModeTDM {
		w.teamPoint(killer.Team, delta)
	}
}

// Flag positions are authority-owned. A carrier keeps ordinary movement and weapons.
type Flag struct {
	Team     Team
	State    string
	Carrier  int
	Position core.Vec2
}

func (w *World) resetFlags() {
	w.Flags = []Flag{}
	if w.Rules.Mode != ModeCTF {
		return
	}
	for _, team := range []Team{TeamBlue, TeamRed} {
		w.Flags = append(w.Flags, Flag{Team: team, State: "home", Position: w.teamBase(team).Base})
	}
}
func (w *World) dropFlag(p *Player) {
	for i := range w.Flags {
		f := &w.Flags[i]
		if f.Carrier == p.ID {
			f.State = "dropped"
			f.Carrier = 0
			f.Position = core.Vec2{X: p.State.X, Y: p.State.Y}
			w.activity("flag-drop", p, nil, "")
		}
	}
}
func (w *World) updateFlags() {
	if w.Rules.Mode != ModeCTF {
		return
	}
	for i := range w.Flags {
		f := &w.Flags[i]
		if carrier := w.Find(f.Carrier); carrier != nil {
			f.Position = core.Vec2{X: carrier.State.X, Y: carrier.State.Y}
		}
	}
	// Recover friendly flags before captures, with stable player IDs for ties.
	for _, p := range w.Players {
		if p.Status != "alive" {
			continue
		}
		for i := range w.Flags {
			f := &w.Flags[i]
			radius := .25
			if f.State == "dropped" {
				radius = .5
			}
			if f.Carrier != 0 || math.Hypot(p.State.X-f.Position.X, p.State.Y-f.Position.Y) > radius {
				continue
			}
			if f.Team == p.Team {
				if f.State == "dropped" {
					f.State = "home"
					f.Position = w.teamBase(f.Team).Base
					w.activity("flag-return", p, nil, "")
				}
			} else {
				f.State = "carried"
				f.Carrier = p.ID
				f.Position = core.Vec2{X: p.State.X, Y: p.State.Y}
				w.activity("flag-take", p, nil, "")
			}
		}
	}
	for i := range w.Flags {
		f := &w.Flags[i]
		p := w.Find(f.Carrier)
		if p == nil || p.Status != "alive" {
			continue
		}
		home := w.teamBase(p.Team).Base
		ownHome := false
		for _, own := range w.Flags {
			if own.Team == p.Team && own.State == "home" {
				ownHome = true
			}
		}
		if ownHome && math.Hypot(p.State.X-home.X, p.State.Y-home.Y) <= .25 {
			p.Score++
			w.teamPoint(p.Team, 1)
			w.activity("flag-capture", p, nil, "")
			f.Carrier = 0
			f.State = "home"
			f.Position = w.teamBase(f.Team).Base
		}
	}
}
