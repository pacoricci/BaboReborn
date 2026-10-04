package match

import (
	"math"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/internal/testcontent"
)

func modeWorld(t *testing.T, mode string) *World {
	t.Helper()
	w := MustNew(testcontent.Map("twin-forts"))
	r := DefaultRules()
	r.Mode = mode
	r.ScoreLimit = 0
	r.TimeLimitTicks = 0
	if err := w.Configure(r); err != nil {
		t.Fatal(err)
	}
	return w
}
func TestAutomaticTeamsFollowParticipationAndSurviveRespawn(t *testing.T) {
	w := modeWorld(t, ModeTDM)
	spectator := w.Add()
	a, b, c := w.Add(), w.Add(), w.Add()
	w.Spawn(a)
	w.Spawn(b)
	w.Spawn(c)
	if spectator.Team != TeamNone || a.Team != TeamBlue || b.Team != TeamRed || c.Team != TeamBlue {
		t.Fatal("bad auto assignment")
	}
	w.Remove(b.ID)
	d := w.Add()
	w.Spawn(d)
	if d.Team != TeamRed {
		t.Fatal("did not fill smaller team")
	}
	c.Status = "dead"
	c.Died = -1000
	w.Spawn(c)
	if c.Team != TeamBlue {
		t.Fatal("respawn switched team")
	}
	for _, p := range []*Player{a, c, d} {
		side := w.teamBase(p.Team)
		found := false
		for _, s := range side.Spawns {
			if p.State.X == s.X && p.State.Y == s.Y {
				found = true
			}
		}
		if !found {
			t.Fatal("spawn outside assigned side")
		}
	}
}
func TestTeamScoresEndFreezeAndReset(t *testing.T) {
	w := modeWorld(t, ModeTDM)
	a, b := w.Add(), w.Add()
	w.Spawn(a)
	w.Spawn(b)
	w.scoreKill(a, b)
	w.scoreKill(a, a)
	if w.Match.Scores.Blue != 0 || a.Score != 0 {
		t.Fatal("suicide penalty missing")
	}
	w.scoreKill(a, b)
	w.Rules.ScoreLimit = 1
	w.checkLimits()
	if w.Match.Phase != "intermission" || w.Match.Ranking[0].Team != TeamBlue {
		t.Fatal("team win not frozen")
	}
	w.Remove(a.ID)
	if w.Match.Scores.Blue != 1 {
		t.Fatal("departure lost team score")
	}
	w.Tick = w.Match.Ends
	w.advanceMatch()
	if w.Match.Scores.Blue != 0 || w.Match.Phase != "playing" || b.Team != TeamRed {
		t.Fatal("round reset")
	}
	w.Rules.TimeLimitTicks = 1
	w.Tick++
	w.checkLimits()
	if w.Match.Phase != "intermission" || w.Match.Scores.Blue != w.Match.Scores.Red {
		t.Fatal("timed draw must end without overtime")
	}
}
func TestCTFRequiresCompatibleMap(t *testing.T) {
	w := MustNew(testcontent.Map("yard"))
	w.Arena.Teams = nil
	r := DefaultRules()
	r.Mode = ModeCTF
	if w.Configure(r) == nil {
		t.Fatal("CTF accepted DM map")
	}
}
func TestCTFFlagLifecycleAndCaptureGate(t *testing.T) {
	w := modeWorld(t, ModeCTF)
	a, b := w.Add(), w.Add()
	w.Spawn(a)
	w.Spawn(b)
	blue, red := w.Arena.Teams.Blue.Base, w.Arena.Teams.Red.Base
	a.State.X, a.State.Y = red.X, red.Y
	w.updateFlags()
	if w.Flags[1].Carrier != a.ID {
		t.Fatal("enemy flag not taken")
	}
	b.State.X, b.State.Y = blue.X, blue.Y
	w.updateFlags()
	a.State.X, a.State.Y = blue.X, blue.Y
	w.updateFlags()
	if w.Match.Scores.Blue != 0 {
		t.Fatal("captured without own flag home")
	}
	// A flag is dropped at the carrier, including disconnect, and recovered on touch.
	b.State.X, b.State.Y = blue.X+1, blue.Y
	w.Remove(b.ID)
	if w.Flags[0].State != "dropped" || w.Flags[0].Carrier != 0 {
		t.Fatal("disconnect retained carrier")
	}
	a.State.X = blue.X + 1
	w.updateFlags()
	if w.Flags[0].State != "home" {
		t.Fatal("friendly touch did not return")
	}
	a.State.X = blue.X
	w.updateFlags()
	if w.Match.Scores.Blue != 1 || a.Score != 1 || w.Flags[1].State != "home" {
		t.Fatal("capture failed")
	}
	a.State.X, a.State.Y = red.X, red.Y
	w.updateFlags()
	a.body = core.Body{HP: 0}
	w.resolveDeaths(a.ID, "grenade")
	if w.Flags[1].State != "dropped" || a.Score != 1 {
		t.Fatal("death must drop flag without CTF point penalty")
	}
	w.Rules.ScoreLimit = 1
	w.checkLimits()
	w.Tick = w.Match.Ends
	w.advanceMatch()
	if w.Flags[1].State != "home" || w.Match.Scores.Blue != 0 {
		t.Fatal("flag reset")
	}
}
func TestCTFPickupRadiiAndSingleCarrier(t *testing.T) {
	w := modeWorld(t, ModeCTF)
	a := w.Add()
	w.Spawn(a)
	base := w.Arena.Teams.Red.Base
	a.State.X, a.State.Y = base.X+.26, base.Y
	w.updateFlags()
	if w.Flags[1].State != "home" {
		t.Fatal("home radius too wide")
	}
	a.State.X = base.X + .24
	w.updateFlags()
	w.dropFlag(a)
	a.State.X += .49
	w.updateFlags()
	if w.Flags[1].Carrier != a.ID {
		t.Fatal("dropped pickup radius")
	}
}
func TestAllPrimariesIgnoreAlliesInTeamModes(t *testing.T) {
	for _, mode := range []string{ModeTDM, ModeCTF} {
		for _, weapon := range []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"} {
			t.Run(mode+"/"+weapon, func(t *testing.T) {
				w := modeWorld(t, mode)
				a, b, c := w.Add(), w.Add(), w.Add()
				w.Spawn(a)
				w.Spawn(b)
				w.Spawn(c)
				// Enemy is directly behind an ally, outside spawn immunity and contact grace.
				for _, p := range []*Player{a, b, c} {
					p.Born = -10000
					p.State = core.NewPlayer(core.Vec2{X: 4, Y: 3}, 0)
				}
				a.State.Equipment = core.NewEquipment(weapon, "shield")
				a.State.Cooldown = 0
				b.State.X = 6
				c.State.X = 5
				for range 360 {
					if a.Status == "alive" {
						command(t, w, a, core.Input{Aim: core.Vec2{X: b.State.X, Y: b.State.Y}, Fire: true})
					}
					w.Step()
					if c.HP != 100 {
						t.Fatalf("%s hit ally: %v", weapon, c.HP)
					}
				}
				if b.HP >= 100 {
					t.Fatalf("%s did not hit enemy", weapon)
				}
			})
		}
	}
}
func TestTeamAreaDamageAndDevicesIgnoreAllies(t *testing.T) {
	for _, kind := range []string{"grenade", "molotov", "knives", "photon", "minibot"} {
		t.Run(kind, func(t *testing.T) {
			w := modeWorld(t, ModeTDM)
			a, b, c := w.Add(), w.Add(), w.Add()
			w.Spawn(a)
			w.Spawn(b)
			w.Spawn(c)
			for _, p := range []*Player{a, b, c} {
				p.Born = -10000
				p.State = core.NewPlayer(core.Vec2{X: 4, Y: 3}, 0)
			}
			a.State.X = 2
			b.State.X = 5
			c.State.X = 4.5
			w.Step()
			pos := core.Vec3{X: 4, Y: 3, Z: .25}
			switch kind {
			case "photon":
				p := w.projectile(kind, a.ID, core.Flight{Position: pos})
				p.end = core.Vec3{X: 7, Y: 3, Z: .25}
				p.nextDamage = w.Tick
				w.arsenalEntity(p)
			case "minibot":
				p := w.projectile(kind, a.ID, core.Flight{Position: pos})
				w.turret(p)
			default:
				w.damageArea(a.ID, pos, 4, 50, true, false, kind)
			}
			if c.HP != 100 || b.HP >= 100 {
				t.Fatalf("%s: ally %v enemy %v", kind, c.HP, b.HP)
			}
			if kind == "minibot" && len(shotEvents(w)) > 0 && math.Abs(w.Projectiles[0].Turret.Angle) > .01 {
				t.Fatal("turret targeted ally")
			}
		})
	}
}
