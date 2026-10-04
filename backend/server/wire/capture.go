package wire

import (
	"slices"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/match"
)

// Capture reads a consistent tick on the world-owner goroutine. It does not drain
// events. Every mutable reference is detached, so the result may then be retained,
// serialized concurrently with world updates, or modified without changing authority.
// Sharing one result between consumers still requires ordinary read-only ownership.
func Capture(w *match.World) Snapshot {
	out := Snapshot{CapturedAtMS: w.TimeMS, Type: "snapshot", Version: gameconfig.ProtocolVersion, Tick: w.Tick, EventCut: w.EventCut()}
	out.Players = project(w.Players, func(p *match.Player) Player {
		return Player{Team: string(p.Team), Nickname: p.Nickname, NicknameColors: p.NicknameColors, Appearance: appearance(p.Appearance), ID: p.ID, State: p.State, HP: p.HP, Status: p.Status, Life: p.Life, BornTick: p.Born, DiedTick: p.Died, Ack: p.Ack, Seed: p.Seed}
	})
	out.Items = project(w.Items, func(i *match.Item) Item {
		m := w.ItemMotion(i)
		out := Item{ID: i.ID, Kind: i.Kind, Motion: m.Mode, MotionTick: m.Tick, Position: m.Position, Velocity: m.Velocity, ExpiresTick: i.Expires}
		if i.Kind == "weapon" {
			out.Primary = i.Primary
		}
		return out
	})
	// Photon beams are presented through shot cues; their simulated segments
	// have never been rendered by the client.
	if w.Projectiles != nil {
		out.Projectiles = make([]Projectile, 0, len(w.Projectiles))
	}
	for _, p := range w.Projectiles {
		if p.Kind == "photon" {
			continue
		}
		m := w.ProjectileMotion(p)
		projectile := Projectile{ID: p.ID, Kind: p.Kind, OwnerID: p.Owner, BornTick: p.Born, ExpiresTick: p.Expires, AttachedID: p.Attached, Motion: m.Mode, MotionTick: m.Tick, Position: m.Position, Velocity: m.Velocity}
		if p.Turret != nil {
			projectile.Turret = &Turret{Angle: p.Turret.Angle, LastShotTick: p.Turret.LastShot}
		}
		out.Projectiles = append(out.Projectiles, projectile)
	}
	out.Flags = project(w.Flags, func(f match.Flag) Flag {
		position := Point2{X: f.Position.X, Y: f.Position.Y}
		if f.State == "carried" {
			position = Point2{}
		}
		return Flag{Team: string(f.Team), State: f.State, CarrierID: f.Carrier, Position: position}
	})
	r := w.Rules
	out.Match = Match{Scores: TeamScores{Blue: w.Match.Scores.Blue, Red: w.Match.Scores.Red}, Round: w.Match.Round, Phase: w.Match.Phase, StartedTick: w.Match.Started, EndsTick: w.Match.Ends,
		Rules: MatchRules{Mode: r.Mode, ScoreLimit: r.ScoreLimit, TimeLimitTicks: r.TimeLimitTicks, RespawnTicks: r.RespawnTicks, EndTicks: r.EndTicks, ForceRespawn: r.ForceRespawn},
		Ranking: project(w.Standings(), func(s match.Standing) Standing {
			return Standing{Team: string(s.Team), ID: s.ID, Score: s.Score, Kills: s.Kills, Deaths: s.Deaths}
		}),
	}
	return out
}

// CaptureActivities detaches the feed history for installation checkpoints only.
// Ordinary state publication uses Capture; new activities travel as required events.
func CaptureActivities(w *match.World) []Activity {
	return project(w.Activities, activity)
}

func appearance(a match.Appearance) Appearance {
	return Appearance{Template: a.Template, Colors: slices.Clone(a.Colors)}
}
func participant(p match.Participant) Participant {
	return Participant{ID: p.ID, Nickname: p.Nickname, NicknameColors: p.NicknameColors, Team: string(p.Team)}
}
func activity(a match.Activity) Activity {
	out := Activity{OccurredAtMS: a.OccurredAtMS, ID: a.ID, Tick: a.Tick, Round: a.Round, Kind: a.Kind, Actor: participant(a.Actor), Weapon: a.Weapon}
	if a.Victim != nil {
		victim := participant(*a.Victim)
		out.Victim = &victim
	}
	return out
}

// Preserve nil versus empty arrays as well as order, independently of source capacity.
func project[A, B any](values []A, convert func(A) B) []B {
	if values == nil {
		return nil
	}
	out := make([]B, len(values))
	for i, value := range values {
		out[i] = convert(value)
	}
	return out
}
