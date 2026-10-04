package wire_test

import (
	"encoding/json"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/wire"
)

// A fixed serialization workload, not a simulation or network load test.
func snapshotWorkload() *match.World {
	w := match.MustNew([]byte(`{"name":"Snapshot benchmark","schema":1,"theme":"classic","id":"synthetic","author":"Tests","width":36,"height":36,"walls":[],"spawns":[{"x":4,"y":4},{"x":10,"y":4}]}`))
	primaries := []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"}
	secondaries := []string{"knives", "shield", "minibot"}
	kinds := []string{"rocket", "grenade", "molotov", "flame", "minibot"}
	var history []match.Activity
	for i := range match.MaxPlayers {
		p := w.Add()
		p.NextPrimary, p.NextSecondary = primaries[i%8], secondaries[i%len(secondaries)]
		w.Spawn(p)
		p.State.X, p.State.Y, p.Score, p.Kills, p.Deaths = 2+float64(i%4)*6, 2+float64(i/4)*6, i%5, i%5+1, 1
		p.State.Equipment.Heat, p.State.Equipment.Charge = .6, .25
		flight := core.Flight{Position: core.Vec3{X: p.State.X + 1, Y: p.State.Y, Z: .3}, Velocity: core.Vec3{X: 1, Y: .5, Z: 2}}
		w.Items = append(w.Items, &match.Item{ID: i + 1, Kind: "weapon", Primary: p.NextPrimary, Expires: 1000, Flight: flight})
		projectile := &match.Projectile{ID: i + 17, Kind: kinds[i%len(kinds)], Owner: p.ID, Born: 1, Expires: 500, Flight: flight}
		if projectile.Kind == "minibot" {
			projectile.Turret = &match.TurretPresentation{Angle: .75, LastShot: 17}
		}
		w.Projectiles = append(w.Projectiles, projectile)
		target := (i+1)%16 + 1
		shot := &core.Shot{Kind: p.NextPrimary, From: flight.Position, To: core.Vec3{X: 20, Y: 20, Z: .25}, Hit: true, TargetID: &target}
		pellets := map[string]int{"shotgun": gameconfig.ShotgunPellets, "sniper": 3, "dual": 2}[p.NextPrimary]
		if pellets > 0 {
			for j := 0; j < pellets; j++ {
				pellet := *shot
				pellet.Pellets = nil
				pellet.To.X += float64(j) / 10
				shot.Pellets = append(shot.Pellets, &pellet)
			}
		}
		w.Cues = append(w.Cues, match.Cue{ID: i*2 + 1, Tick: 18, Round: 1, Kind: "shot", Owner: p.ID, Life: p.Life, Shot: shot})
		w.Cues = append(w.Cues, match.Cue{ID: i*2 + 2, Tick: 18, Round: 1, Owner: p.ID, Life: p.Life, Kind: "explosion", Position: flight.Position, Radius: gameconfig.BazookaRadius})
		victim := match.Participant{ID: target, Nickname: "Target", Team: match.TeamNone}
		history = append(history, match.Activity{ID: w.EventCut(), Tick: 18, Round: 1, Kind: "kill", Actor: match.Participant{ID: p.ID, Nickname: p.Nickname, Team: p.Team}, Victim: &victim, Weapon: p.NextPrimary})
	}
	w.Activities = history
	w.Events = w.Events[:len(history)]
	for i := range history {
		a := history[i]
		w.Events[i] = match.Event{ID: a.ID, Tick: a.Tick, Round: a.Round, Kind: "activity", Owner: a.Actor.ID, Life: w.Players[i].Life, Activity: &a}
	}
	w.Tick = 20
	return w
}

var snapshotSink any
var encodedSink []byte

// Required capture runs each tick while shot cues wait for the 30 Hz capture.
// The same retained cues must not be copied on every intervening event transfer.
func BenchmarkEventCapture(b *testing.B) {
	w := snapshotWorkload()
	b.ReportAllocs()
	for b.Loop() {
		for range match.SnapshotEvery {
			snapshotSink = wire.CaptureRequiredEvents(w)
		}
		snapshotSink = wire.CaptureCues(w)
	}
}

func BenchmarkSnapshot(b *testing.B) {
	w := snapshotWorkload()
	b.Run("Capture16", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			snapshotSink = wire.Capture(w)
		}
	})
	b.Run("CaptureRecipientEncode16", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			var err error
			encodedSink, err = json.Marshal(wire.Capture(w).ForRecipient(1))
			if err != nil {
				b.Fatal(err)
			}
		}
		b.ReportMetric(float64(len(encodedSink)), "payload-B")
	})
}
