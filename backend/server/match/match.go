package match

import (
	"errors"
	"math"
	"slices"
	"sort"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

type MatchRules struct {
	Mode           string
	ScoreLimit     int
	TimeLimitTicks int
	RespawnTicks   int
	EndTicks       int
	ForceRespawn   bool
}

// durationTicks rounds configured seconds up so a timer never expires early.
func durationTicks(seconds float64) int { return int(math.Ceil(seconds * gameconfig.TickHz)) }

func DefaultRules() MatchRules {
	return MatchRules{Mode: ModeDM, ScoreLimit: gameconfig.DeathmatchScoreLimit, TimeLimitTicks: durationTicks(gameconfig.DeathmatchTimeLimitSeconds), RespawnTicks: durationTicks(gameconfig.DeathmatchRespawnSeconds), EndTicks: durationTicks(gameconfig.DeathmatchEndSeconds), ForceRespawn: gameconfig.DeathmatchForceRespawn}
}

type Standing struct {
	Team   Team
	ID     int
	Score  int
	Kills  int
	Deaths int
}
type Match struct {
	Scores  TeamScores
	Round   int
	Phase   string
	Started int
	Ends    int
	Ranking []Standing
}

func (w *World) Configure(r MatchRules) error {
	if r.ScoreLimit < 0 || r.TimeLimitTicks < 0 || r.RespawnTicks < 0 || r.EndTicks < 1 {
		return errors.New("invalid match limits")
	}
	if r.Mode == "" {
		r.Mode = ModeDM
	}
	if !ValidMode(r.Mode) {
		return errors.New("unknown match mode")
	}
	if r.Mode != w.Rules.Mode && (w.Tick != 0 || len(w.Players) != 0) {
		return errors.New("set mode before players join")
	}
	if err := w.validateMode(r.Mode); err != nil {
		return err
	}
	changed := r.Mode != w.Rules.Mode
	w.Rules = r
	if changed {
		w.resetFlags()
	}
	return nil
}
func (w *World) Select(p *Player, primary, secondary string) error {
	if !core.IsPrimary(primary) || !core.IsSecondary(secondary) {
		return errors.New("unsupported equipment")
	}
	p.NextPrimary = primary
	p.NextSecondary = secondary
	return nil
}

// Standings returns an owned ranking at the current tick. Call on the world owner;
// frozen intermission standings retain participants who have since disconnected.
func (w *World) Standings() []Standing {
	if w.Match.Phase == "playing" {
		return w.ranking()
	}
	return slices.Clone(w.Match.Ranking)
}
func (w *World) ranking() []Standing {
	rows := make([]Standing, 0, len(w.Players))
	for _, p := range w.Players {
		if p.Status != "spectator" {
			rows = append(rows, Standing{ID: p.ID, Team: p.Team, Score: p.Score, Kills: p.Kills, Deaths: p.Deaths})
		}
	}
	// ID only stabilizes presentation of ties; it does not award a winner or overtime.
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Score > rows[j].Score })
	return rows
}
func (w *World) checkLimits() {
	ended := w.Rules.TimeLimitTicks > 0 && w.Tick-w.Match.Started >= w.Rules.TimeLimitTicks
	for _, p := range w.Players {
		if !w.teamMode() && w.Rules.ScoreLimit > 0 && p.Score >= w.Rules.ScoreLimit {
			ended = true
		}
	}
	if w.teamMode() && w.Rules.ScoreLimit > 0 && (w.Match.Scores.Blue >= w.Rules.ScoreLimit || w.Match.Scores.Red >= w.Rules.ScoreLimit) {
		ended = true
	}
	if !ended {
		return
	}
	w.Match.Phase = "intermission"
	w.Match.Ends = w.Tick + w.Rules.EndTicks
	w.Match.Ranking = w.ranking()
	w.event(Event{Kind: "phase", Phase: "intermission"})
	for _, p := range w.Players {
		w.Release(p)
	}
}
func (w *World) advanceMatch() bool {
	if w.Match.Phase == "intermission" {
		if w.Tick < w.Match.Ends {
			return true
		}
		if len(w.rotation) > 0 {
			w.activateMap(w.Match.Round % len(w.rotation))
		}
		w.Match = Match{Round: w.Match.Round + 1, Phase: "playing", Started: w.Tick, Ranking: []Standing{}}
		w.event(Event{Kind: "phase", Phase: "playing"})
		w.resetFlags()
		w.Items = w.Items[:0]
		w.Projectiles = w.Projectiles[:0]
		w.Activities = w.Activities[:0]
		for _, p := range w.Players {
			p.Score = 0
			p.Kills = 0
			p.Deaths = 0
			p.HP = 0
			p.State = core.NewPlayer(w.Arena.Spawns[0], math.Pi/2)
			if p.Status != "spectator" {
				p.Status = "dead"
				p.Died = w.Tick - w.Rules.RespawnTicks
			}
			p.Life++
			w.Release(p)
		}
	}
	if w.Rules.ForceRespawn {
		for _, p := range w.Players {
			if p.Status == "dead" {
				w.Spawn(p)
			}
		}
	}
	return false
}
func (w *World) resolveDeaths(attacker int, weapon string) {
	for _, p := range w.Players {
		if p.Status == "alive" && p.body.HP < p.HP {
			if p.body.Shield {
				w.signal("shield-hit", p.ID, core.Vec3{X: p.body.X, Y: p.body.Y, Z: core.Radius})
			}
			w.event(Event{Kind: "damage", Owner: p.ID, Source: attacker, Weapon: weapon, Amount: p.HP - max(0, p.body.HP), Position: core.Vec3{X: p.body.X, Y: p.body.Y, Z: core.Radius}})
		}
		p.HP = p.body.HP
		if p.Status != "alive" || p.HP > 0 {
			continue
		}
		w.dropFlag(p)
		w.drop(p)
		w.event(Event{Kind: "death", Owner: p.ID, Source: attacker, Weapon: weapon, Position: core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}})
		p.Status = "dead"
		p.Died = w.Tick
		p.Deaths++
		p.State.VX = 0
		p.State.VY = 0
		w.Release(p)
		if killer := w.Find(attacker); killer != nil {
			w.activity("kill", killer, p, weapon)
			w.scoreKill(killer, p)
		}
	}
}
func (w *World) damageArea(owner int, position core.Vec3, radius, damage float64, uniform, excludeOwner bool, weapon string) bool {
	if w.Find(owner) == nil {
		return false
	}
	hit := false
	for _, p := range w.Players {
		if p.Status != "alive" || !w.canDamage(owner, p) || excludeOwner && p.ID == owner {
			continue
		}
		amount := core.AreaDamage(position, radius, damage, uniform, &p.body, w.Geometry.Walls, Geometry.WallHeight)
		before := p.body.HP
		core.ApplyDamage(&p.body, amount)
		if p.ID != owner && p.body.HP < before {
			hit = true
		}
	}
	w.resolveDeaths(owner, weapon)
	return hit
}
