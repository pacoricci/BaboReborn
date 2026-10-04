package match

import (
	"testing"

	"baboreborn/backend/core"
)

func TestActivityDeathIdentityAndDeathmatchAffiliation(t *testing.T) {
	w, a, b := equipPair()
	a.Team, b.Team = TeamBlue, TeamBlue
	a.Nickname, b.Nickname = "Alice", "Bob"
	b.body.HP = 0
	w.resolveDeaths(a.ID, "shotgun")
	w.resolveDeaths(a.ID, "shotgun")
	e := w.Activities[len(w.Activities)-1]
	if e.Kind != "kill" || e.Weapon != "shotgun" || e.Victim.Nickname != "Bob" || a.Score != 1 || b.Deaths != 1 {
		t.Fatal(e, a.Score, b.Deaths)
	}
	id := e.ID
	b.Nickname = "Renamed"
	w.Remove(b.ID)
	if e.Victim.Nickname != "Bob" || w.Activities[len(w.Activities)-1].ID != id+1 {
		t.Fatal("identity or duplicate death")
	}
	a.body.HP = 0
	w.resolveDeaths(a.ID, "grenade")
	e = w.Activities[len(w.Activities)-1]
	if e.Actor.ID != e.Victim.ID || a.Score != 0 {
		t.Fatal("suicide")
	}
}
func TestActivityAreaDamageAndWindow(t *testing.T) {
	w, a, b := equipPair()
	a.body.Immune = true
	b.body.X, b.body.Y = 4, 4
	w.damageArea(a.ID, core.Vec3{X: 4, Y: 4, Z: .25}, 4, 150, true, false, "molotov")
	e := w.Activities[len(w.Activities)-1]
	if e.Kind != "kill" || e.Weapon != "molotov" || e.Victim.ID != b.ID {
		t.Fatal(e)
	}
	for i := 0; i < 80; i++ {
		w.activity("connected", a, nil, "")
	}
	if len(w.Activities) != 64 {
		t.Fatal("unbounded window")
	}
	w.Match.Phase, w.Match.Ends = "intermission", w.Tick
	w.advanceMatch()
	if len(w.Activities) != 0 {
		t.Fatal("round retained old activity")
	}
}

func TestPrimaryKillKeepsCauseWithSimultaneousKnives(t *testing.T) {
	w, a, b := equipPair()
	a.Team, b.Team = TeamBlue, TeamBlue
	b.HP = 1
	command(t, w, a, core.Input{Aim: core.Vec2{X: 7, Y: 4}, Fire: true, Secondary: true})
	w.Step()
	e := w.Activities[len(w.Activities)-1]
	if e.Kind != "kill" || e.Weapon != "smg" || e.Victim.ID != b.ID || a.Score != 1 {
		t.Fatal("same-team Deathmatch shot must keep its cause before the knife action", e)
	}
}
