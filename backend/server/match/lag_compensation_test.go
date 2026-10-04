package match

import (
	"math"
	"reflect"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

func lagDuel() (*World, *Player, *Player, ShotView) {
	w, a, b := alivePair()
	w.Tick = 500
	for w.Tick < 520 {
		b.State.Y = 8
		if w.Tick == 500 {
			b.State.Y = 2
		}
		if w.Tick == 504 {
			b.State.Y = 6
		}
		w.TimeMS = int64((w.Tick + 1) * 1000 / gameconfig.TickHz)
		w.Step()
	}
	a.State.Cooldown = 0
	a.State.Angle = 0
	return w, a, b, ShotView{Round: 1, From: 501, To: 505, Latest: 513, Alpha: .5}
}

func fireView(t *testing.T, w *World, a *Player, view *ShotView) {
	t.Helper()
	a.State.Angle = 0
	if err := w.Submit(a, []Command{{Seq: a.accepted + 1, Life: a.Life, View: view,
		Input: core.Input{Fire: true, Aim: core.Vec2{X: 10, Y: 4}}}}); err != nil {
		t.Fatal(err)
	}
	w.TimeMS += 8
	w.Step()
}

func TestLagCompensationUsesRenderedInterpolationAndKeepsCurrentPosition(t *testing.T) {
	for _, primary := range []string{"smg", "shotgun", "dual", "chain", "sniper"} {
		t.Run(primary, func(t *testing.T) {
			w, a, b, view := lagDuel()
			a.State.Equipment = core.NewEquipment(primary, "knives")
			fireView(t, w, a, &view)
			if b.HP >= 100 || b.State.Y != 8 || b.body.Y != 8 || !hasHit(w) {
				t.Fatalf("interpolated hit missing or live position rewound: hp=%v y=%v body=%v", b.HP, b.State.Y, b.body.Y)
			}
			for _, e := range w.Events {
				if e.Kind == "damage" && (e.Position.Y != 8 || e.Tick != w.Tick || e.Life != b.Life) {
					t.Fatal("damage must belong to the current authority", e)
				}
			}
		})
	}
}

func TestLagCompensationFallbacksAndBounds(t *testing.T) {
	cases := map[string]func(*World, *Player, *Player, *ShotView){
		"future":      func(w *World, _, _ *Player, v *ShotView) { v.Latest = w.Tick + 1 },
		"wrong round": func(_ *World, _, _ *Player, v *ShotView) { v.Round++ },
		"overwritten history": func(w *World, _, _ *Player, _ *ShotView) {
			for range 31 {
				w.TimeMS += 8
				w.Step()
			}
		},
		"wall clock stall": func(w *World, _, _ *Player, _ *ShotView) { w.TimeMS += 251 },
		"past window":      func(w *World, _, _ *Player, _ *ShotView) { w.Tick = 531 },
		"new shooter life": func(_ *World, a, _ *Player, _ *ShotView) { a.Life++ },
		"missing history":  func(_ *World, _, _ *Player, v *ShotView) { v.From = 500 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			w, a, b, view := lagDuel()
			change(w, a, b, &view)
			fireView(t, w, a, &view)
			if b.HP != 100 || len(shotEvents(w)) != 1 {
				t.Fatal("invalid history changed hit or cadence", b.HP)
			}
		})
	}
	t.Run("no view", func(t *testing.T) {
		w, a, b, _ := lagDuel()
		fireView(t, w, a, nil)
		if b.HP != 100 {
			t.Fatal("ordinary shot rewound")
		}
	})
	t.Run("inclusive 250ms", func(t *testing.T) {
		w, a, b, view := lagDuel()
		w.Tick = 530 // The fire executes at exactly 30 ticks after From.
		w.TimeMS = w.history[view.From%len(w.history)].timeMS + 242
		fireView(t, w, a, &view)
		if b.HP == 100 {
			t.Fatal("boundary shot not compensated")
		}
	})
}

func TestLagCompensationCannotHitNewLifeOrUnseenPlayer(t *testing.T) {
	for _, kind := range []string{"respawn", "new player", "team change"} {
		t.Run(kind, func(t *testing.T) {
			w, a, b, view := lagDuel()
			switch kind {
			case "respawn":
				b.Life++
			case "new player":
				w.Remove(b.ID)
				b = w.Add()
				w.Spawn(b)
				b.Born = 0
			case "team change":
				b.Team = TeamRed
			}
			b.State = core.NewPlayer(core.Vec2{X: 7, Y: 4}, 0)
			fireView(t, w, a, &view)
			if b.HP != 100 || hasHit(w) {
				t.Fatal("old view hit a different life or membership", b.HP)
			}
		})
	}
}

func TestLagCompensationUsesLatestPositionAcrossTargetRespawn(t *testing.T) {
	w, a, b, view := lagDuel()
	// Match the browser fallback when the interpolation endpoints precede a respawn.
	f := &w.history[view.Latest%len(w.history)]
	shown := f.player(b.ID)
	b.Life++
	shown.life, shown.y = b.Life, 4
	fireView(t, w, a, &view)
	if b.HP == 100 || b.State.Y != 8 {
		t.Fatal("latest-life fallback did not match rendered position")
	}
}

func TestLagCompensationCoverProtectionAndDeath(t *testing.T) {
	t.Run("wall blocks historical ray", func(t *testing.T) {
		w, a, b, view := lagDuel()
		w.Geometry.Walls = []core.Wall{{X: 5, Y: 3, W: 1, H: 2}}
		w.Geometry.Grid = core.NewGrid(core.Wall{W: 20, H: 20}, w.Geometry.Walls)
		fireView(t, w, a, &view)
		if b.HP != 100 || hasHit(w) {
			t.Fatal("rewind bypassed wall")
		}
	})
	t.Run("target reached cover after displayed scene", func(t *testing.T) {
		w, a, b, view := lagDuel()
		w.Geometry.Walls = []core.Wall{{X: 5, Y: 6, W: 1, H: 3}}
		w.Geometry.Grid = core.NewGrid(core.Wall{W: 20, H: 20}, w.Geometry.Walls)
		fireView(t, w, a, &view)
		if b.HP == 100 || b.State.Y != 8 {
			t.Fatal("historical exposed position was not hit")
		}
	})
	for _, phase := range []string{"shown", "current"} {
		t.Run("spawn immunity "+phase, func(t *testing.T) {
			w, a, b, view := lagDuel()
			if phase == "shown" {
				w.history[view.Latest%len(w.history)].player(b.ID).immune = true
			} else {
				b.Born = w.Tick
			}
			fireView(t, w, a, &view)
			if b.HP != 100 || !hasHit(w) {
				t.Fatal("rewind bypassed spawn immunity")
			}
		})
	}
	for _, phase := range []string{"shown", "current"} {
		t.Run("shield "+phase, func(t *testing.T) {
			w, a, b, view := lagDuel()
			if phase == "shown" {
				w.history[view.To%len(w.history)].player(b.ID).shield = true
			} else {
				b.State.Equipment.Protection = 1
			}
			fireView(t, w, a, &view)
			if b.HP != 100-core.Damage*gameconfig.ShieldDamageMultiplier || !hasHit(w) {
				t.Fatal("rewind bypassed shield", b.HP)
			}
		})
	}
	t.Run("death and duplicate", func(t *testing.T) {
		w, a, b, view := lagDuel()
		b.HP = 1
		fireView(t, w, a, &view)
		if b.Status != "dead" || a.Kills != 1 {
			t.Fatal("historical hit did not resolve current death")
		}
		if err := w.Submit(a, []Command{{Seq: 1, Life: a.Life, View: &view, Input: core.Input{Fire: true}}}); err != nil {
			t.Fatal(err)
		}
		w.Step()
		if a.Kills != 1 || len(shotEvents(w)) != 1 {
			t.Fatal("duplicate applied damage twice")
		}
	})
}

func TestLagCompensationPreservesTeamRulesAndOtherPrimaries(t *testing.T) {
	for _, mode := range []string{ModeTDM, ModeCTF} {
		t.Run(mode, func(t *testing.T) {
			w, a, b, view := lagDuel()
			w.Rules.Mode = mode
			a.Team, b.Team = TeamBlue, TeamBlue
			for i := range w.history {
				for j := 0; j < w.history[i].count; j++ {
					w.history[i].players[j].team = TeamBlue
				}
			}
			fireView(t, w, a, &view)
			if b.HP != 100 || hasHit(w) {
				t.Fatal("historical query damaged teammate")
			}
		})
	}
	for _, primary := range []string{"bazooka", "photon", "flamethrower"} {
		t.Run(primary, func(t *testing.T) {
			w, a, b, view := lagDuel()
			ordinary, shooter, target, _ := lagDuel()
			for _, p := range []*Player{a, shooter} {
				p.State.Equipment = core.NewEquipment(primary, "knives")
				p.State.Equipment.Charge = gameconfig.PhotonChargeSeconds
			}
			fireView(t, w, a, &view)
			fireView(t, ordinary, shooter, nil)
			if b.HP != target.HP || !reflect.DeepEqual(a.State, shooter.State) || !reflect.DeepEqual(w.Projectiles, ordinary.Projectiles) || !reflect.DeepEqual(w.Cues, ordinary.Cues) {
				t.Fatal("view changed an uncompensated primary")
			}
		})
	}
}

func TestLagCompensationRejectsMalformedViewWithoutAcceptingBatch(t *testing.T) {
	for _, change := range []func(*ShotView){
		func(v *ShotView) { v.Alpha = math.NaN() }, func(v *ShotView) { v.Alpha = math.Inf(1) },
		func(v *ShotView) { v.Alpha = -0.1 }, func(v *ShotView) { v.Alpha = 1.1 },
		func(v *ShotView) { v.From = -1 }, func(v *ShotView) { v.To = v.From - 1 },
		func(v *ShotView) { v.Latest = v.To - 1 }, func(v *ShotView) { v.Round = 0 },
	} {
		w, a, _, view := lagDuel()
		change(&view)
		if w.Submit(a, []Command{{Seq: 1, Life: a.Life}, {Seq: 2, Life: a.Life, View: &view}}) == nil || a.accepted != 0 || len(a.queue) != 0 {
			t.Fatal("malformed view accepted or batch partially applied", view)
		}
	}
}

func TestLagCompensationExpiresWhileQueuedAndOwnsView(t *testing.T) {
	w, a, b, view := lagDuel()
	commands := make([]Command, 12)
	for i := range commands {
		commands[i] = Command{Seq: i + 1, Life: a.Life}
	}
	commands[11].Fire, commands[11].View = true, &view
	if err := w.Submit(a, commands); err != nil {
		t.Fatal(err)
	}
	view.Alpha = 0
	if a.queue[11].View.Alpha != .5 {
		t.Fatal("queued view aliases caller")
	}
	for range 12 {
		a.State.Angle = 0
		w.TimeMS += 8
		w.Step()
	}
	if b.HP != 100 || len(shotEvents(w)) != 1 {
		t.Fatal("expired queued view was compensated")
	}
}

func BenchmarkLagCompensation16(b *testing.B) {
	for _, compensated := range []bool{false, true} {
		name := "current"
		if compensated {
			name = "rewind"
		}
		b.Run(name, func(b *testing.B) {
			w := MustNew(arena())
			w.Rules.ScoreLimit, w.Rules.TimeLimitTicks = 0, 0
			for i := 0; i < MaxPlayers; i++ {
				p := w.Add()
				w.Spawn(p)
				p.State.Y = float64(i) + 1
			}
			w.Tick = 500
			for range 20 {
				w.Step()
			}
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				for i, p := range w.Players {
					p.State.X, p.State.Y = 4, float64(i)+1
					p.State.VX, p.State.VY, p.State.Angle = 0, 0, 0
					p.HP, p.Status, p.State.Cooldown = 100, "alive", 0
					c := Command{Seq: p.accepted + 1, Life: p.Life, Input: core.Input{Fire: true, Aim: core.Vec2{X: 10, Y: p.State.Y}}}
					if compensated {
						c.View = &ShotView{Round: w.Match.Round, From: w.Tick - 12, To: w.Tick - 8, Latest: w.Tick - 1, Alpha: .5}
					}
					if err := w.Submit(p, []Command{c}); err != nil {
						b.Fatal(err)
					}
				}
				w.Step()
				w.DrainRequiredEvents()
				w.DrainCues()
			}
		})
	}
}
