package match

import (
	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

const rewindMS = 250
const rewindTicks = gameconfig.TickHz * rewindMS / 1000

// ShotView identifies the interpolation actually rendered, not a client position
// or a freely supplied wall clock. Latest also defines membership and life fallbacks.
type ShotView struct {
	Round  int     `json:"round"`
	From   int     `json:"from"`
	To     int     `json:"to"`
	Latest int     `json:"latest"`
	Alpha  float64 `json:"alpha"`
}

func (v ShotView) valid() bool {
	return v.Round > 0 && v.Round <= 2147483647 && v.From >= 0 && v.From <= v.To &&
		v.To <= v.Latest && v.Latest <= 2147483647 && finite(v.Alpha) && v.Alpha >= 0 && v.Alpha <= 1
}

func compensatedPrimary(primary string) bool {
	switch primary {
	case "smg", "shotgun", "dual", "chain", "sniper":
		return true
	}
	return false
}

type hitPlayer struct {
	id, life       int
	team           Team
	alive          bool
	x, y           float64
	immune, shield bool
}

type hitFrame struct {
	tick, round int
	timeMS      int64
	count       int
	players     [MaxPlayers]hitPlayer
}

func (f *hitFrame) player(id int) *hitPlayer {
	for i := 0; i < f.count; i++ {
		if f.players[i].id == id {
			return &f.players[i]
		}
	}
	return nil
}

func (w *World) rememberHitFrame() {
	f := &w.history[w.Tick%len(w.history)]
	*f = hitFrame{tick: w.Tick, round: w.Match.Round, timeMS: w.TimeMS, count: len(w.Players)}
	for i, p := range w.Players {
		f.players[i] = hitPlayer{id: p.ID, life: p.Life, team: p.Team, alive: p.Status == "alive",
			x: p.State.X, y: p.State.Y,
			immune: w.Tick-p.Born <= durationTicks(gameconfig.DeathmatchSpawnProtectionSeconds-gameconfig.DeathmatchSpawnInactiveTailSeconds),
			shield: p.State.Equipment.Protection > gameconfig.ShieldInactiveTailSeconds}
	}
}

func (w *World) hitFrame(tick int) *hitFrame {
	if tick < 0 || tick >= w.Tick || w.Tick-tick > rewindTicks {
		return nil
	}
	f := &w.history[tick%len(w.history)]
	// Bound both simulation age and elapsed room time, including scheduler stalls.
	if f.tick != tick || f.round != w.Match.Round || w.TimeMS < f.timeMS || w.TimeMS-f.timeMS > rewindMS {
		return nil
	}
	return f
}

func (w *World) shotBodies(shooter *Player, view *ShotView, current []*core.Body, copies *[MaxPlayers]core.Body, targets *[MaxPlayers]*core.Body) []*core.Body {
	if view == nil || !view.valid() || view.Round != w.Match.Round {
		return current
	}
	a, b, latest := w.hitFrame(view.From), w.hitFrame(view.To), w.hitFrame(view.Latest)
	if a == nil || b == nil || latest == nil {
		return current
	}
	own := latest.player(shooter.ID)
	if own == nil || !own.alive || own.life != shooter.Life || own.team != shooter.Team {
		return current
	}
	count := 0
	for _, body := range current {
		p := w.Find(body.ID)
		shown := latest.player(body.ID)
		// An old scene cannot hit a respawn or a player who was not visible in it.
		if shown == nil || !shown.alive || shown.life != p.Life || shown.team != p.Team {
			continue
		}
		before, after := a.player(body.ID), b.player(body.ID)
		x, y := shown.x, shown.y
		shield := shown.shield
		if before != nil && after != nil && before.alive && after.alive && before.life == shown.life && after.life == shown.life {
			x = before.x + (after.x-before.x)*view.Alpha
			y = before.y + (after.y-before.y)*view.Alpha
			// Interpolation takes discrete equipment state from the later endpoint.
			shield = after.shield
		}
		copies[count] = *body
		copies[count].X, copies[count].Y = x, y
		// Protect both the displayed and current state; rewind cannot bypass a shield.
		copies[count].Immune = body.Immune || shown.immune
		copies[count].Shield = body.Shield || shield
		targets[count] = body
		current[count] = &copies[count]
		count++
	}
	return current[:count]
}
