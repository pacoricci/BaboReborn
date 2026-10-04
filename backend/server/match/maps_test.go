package match

import (
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/navigation"
)

func TestRotationRebuildsWorldAndBotsWithoutLosingPlayers(t *testing.T) {
	w := MustNew(testcontent.Map("yard"))
	yard, err := maps.Parse(testcontent.Map("yard"))
	if err != nil {
		t.Fatal(err)
	}
	crossing, err := maps.Parse(testcontent.Map("crossing"))
	if err != nil {
		t.Fatal(err)
	}
	if err := w.ConfigureRotation([]maps.Arena{yard, crossing}, func(g core.Grid) bots.Navigator { return navigation.New(g) }); err != nil {
		t.Fatal(err)
	}
	p := w.Add()
	w.Spawn(p)
	p.Nickname = "Survivor"
	p.Score = 7
	bot, err := w.AddBot(bots.NewSimple(bots.Standard(), 123), navigation.New(w.Geometry.Grid))
	if err != nil {
		t.Fatal(err)
	}
	oldNav := bot.bot.navigation
	oldLife := p.Life
	w.Rules.EndTicks = 1
	p.Score = w.Rules.ScoreLimit
	w.checkLimits()
	w.Step()
	if w.Match.Round != 2 || w.Arena.ID != "crossing" || w.Geometry.Grid.W != 28 || w.Geometry.Grid.H != 20 {
		t.Fatal("map and collision grid did not rotate")
	}
	if w.Find(p.ID) != p || p.Nickname != "Survivor" || p.Score != 0 || p.Life <= oldLife {
		t.Fatal("player identity or reset failed")
	}
	if bot.bot.navigation == oldNav || bot.Status != "alive" {
		t.Fatal("bot navigation/spawn not refreshed")
	}
	if bot.bot.navigation.CanTravel(core.Vec2{X: 32, Y: 32}, core.Vec2{X: 31, Y: 31}) {
		t.Fatal("bot still navigates old bounds")
	}
	// Delayed old-life input can arrive after respawn; it must not move or fire.
	w.Spawn(p)
	before := p.State
	if err := w.Submit(p, []Command{{Seq: 1, Life: oldLife, Input: core.Input{X: 1, Fire: true, Aim: core.Vec2{X: 20, Y: 4}}}}); err != nil {
		t.Fatal(err)
	}
	w.Step()
	if p.State.X != before.X || p.State.Y != before.Y || len(shotEvents(w)) != 0 {
		t.Fatal("stale input crossed the map boundary")
	}
	p.Score = w.Rules.ScoreLimit
	w.checkLimits()
	w.Step()
	if w.Arena.ID != "yard" || w.Match.Round != 3 || len(w.Players) != 2 {
		t.Fatal("rotation did not wrap with players connected")
	}
}

func TestPreparedArenaOwnsDecalsAcrossRoomCopies(t *testing.T) {
	a, err := maps.Parse(testcontent.Map("ion-foundry"))
	if err != nil {
		t.Fatal(err)
	}
	first, err := ownArena(a)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ownArena(a)
	if err != nil {
		t.Fatal(err)
	}
	original := a.Decals[0]
	first.Decals[0].X++
	if a.Decals[0] != original || second.Decals[0] != original {
		t.Fatal("room decal slices alias their source")
	}
}
