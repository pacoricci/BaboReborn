package match

import (
	"math"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/navigation"
)

type recordingBrain struct {
	observations []bots.Observation
	resets       int
	input        core.Input
}

func (b *recordingBrain) Reset() { b.resets++ }
func (b *recordingBrain) Decide(o bots.Observation, _ bots.Navigator) core.Input {
	b.observations = append(b.observations, o)
	return b.input
}
func addTestBot(t *testing.T, w *World, b bots.Brain) *Player {
	t.Helper()
	p, err := w.AddBot(b, navigation.New(w.Geometry.Grid))
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func TestBotPerceptionFiltersWallsRangeAndSpectators(t *testing.T) {
	data := []byte(`{"name":"Synthetic","schema":1,"theme":"classic","id":"synthetic","author":"Tests","width":36,"height":36,"spawns":[{"x":3,"y":3}],"walls":[{"x":5,"y":1,"w":1,"h":8}]}`)
	w := MustNew(data)
	brain := &recordingBrain{input: core.Input{Aim: core.Vec2{X: 4, Y: 3}}}
	p := addTestBot(t, w, brain)
	w.Spawn(p)
	visible, hidden, far, spectator := w.Add(), w.Add(), w.Add(), w.Add()
	for _, q := range []*Player{visible, hidden, far} {
		w.Spawn(q)
	}
	visible.State.X, visible.State.Y = 4, 3
	hidden.State.X, hidden.State.Y = 8, 3
	far.State.X, far.State.Y = 3, 12
	spectator.State.X, spectator.State.Y = 3, 4
	w.Step()
	o := brain.observations[0]
	if len(o.Opponents) != 1 || o.Opponents[0].ID != visible.ID {
		t.Fatal("perception leaked", o.Opponents)
	}
	brain.observations[0].Self.X = 200
	brain.observations[0].Opponents[0].Position.X = 200
	if p.State.X == 200 || visible.State.X == 200 {
		t.Fatal("brain can mutate players")
	}
	for range BotDecisionTicks - 1 {
		w.Step()
	}
	if len(brain.observations) != 1 {
		t.Fatal("brain runs every physics tick")
	}
	w.Step()
	if len(brain.observations) != 2 {
		t.Fatal("missing scheduled decision")
	}
	if brain.observations[0].Opponents[0].Position.X != 200 || brain.observations[1].Opponents[0].Position.X == 200 {
		t.Fatal("perception reused a retained observation slice")
	}
}
func TestBotSharesEquipmentDeathRespawnAndRounds(t *testing.T) {
	w := MustNew([]byte(`{"name":"Synthetic","schema":1,"theme":"classic","id":"synthetic","author":"Tests","width":12,"height":12,"spawns":[{"x":3,"y":3},{"x":7,"y":3}],"walls":[]}`))
	brain := &recordingBrain{input: core.Input{Aim: core.Vec2{X: 7, Y: 3}, Grenade: true}}
	p := addTestBot(t, w, brain)
	w.Step()
	if p.HP != 100 || p.Life != 1 || p.State.Equipment.Grenades != 2 || len(shotEvents(w)) != 0 {
		t.Fatal("spawn or equip delay bypassed", p)
	}
	for range 100 {
		w.Step()
	}
	if len(shotEvents(w)) != 0 {
		t.Fatal("primary equip delay bypassed")
	}
	for range 30 {
		w.Step()
	}
	if p.State.Equipment.Grenades >= 2 {
		t.Fatal("ordinary inventory not consumed")
	}
	brain.input.Fire = true
	brain.input.Grenade = false
	for range 180 {
		w.Step()
	}
	if len(shotEvents(w)) == 0 {
		t.Fatal("bot never fired ordinary primary")
	}
	if p.State.Equipment.Grenades >= 2 {
		t.Fatal("ordinary inventory not consumed")
	}
	p.body.HP = 0
	w.resolveDeaths(p.ID, "smg")
	if p.Status != "dead" || p.Score != -1 || p.Deaths != 1 || len(w.Items) == 0 {
		t.Fatal("death rules bypassed")
	}
	for range w.Rules.RespawnTicks - 1 {
		w.Step()
	}
	if p.Status != "dead" {
		t.Fatal("early respawn")
	}
	w.Step()
	if p.Status != "alive" || p.HP != 100 || p.State.Equipment.Grenades != 2 || brain.resets != 2 {
		t.Fatal("respawn did not reset life and brain", p, brain.resets)
	}
	w.Rules.ScoreLimit = 1
	p.Score = 1
	w.Step()
	if w.Match.Phase != "intermission" {
		t.Fatal("missing match end")
	}
	before := len(brain.observations)
	for range w.Rules.EndTicks - 1 {
		w.Step()
	}
	if len(brain.observations) != before {
		t.Fatal("bot acts during intermission")
	}
	w.Step()
	if w.Match.Round != 2 || p.Status != "alive" || p.Score != 0 || brain.resets != 3 {
		t.Fatal("bot failed next round", p)
	}
}
func TestInvalidReplacementCommandsCannotPoisonWorld(t *testing.T) {
	w := MustNew(testcontent.Map("yard"))
	p := addTestBot(t, w, &recordingBrain{input: core.Input{X: math.NaN(), Fire: true}})
	w.Step()
	if math.IsNaN(p.State.X) || len(shotEvents(w)) != 0 {
		t.Fatal("invalid brain input escaped validation")
	}
}

func TestBotCapacityAndRemoval(t *testing.T) {
	w := MustNew(testcontent.Map("yard"))
	nav := navigation.New(w.Geometry.Grid)
	if _, err := w.AddBot(nil, nav); err == nil || len(w.Players) != 0 {
		t.Fatal("invalid bot allocated a player")
	}
	for range MaxPlayers {
		addTestBot(t, w, &recordingBrain{input: core.Input{Aim: core.Vec2{X: 3, Y: 3}}})
	}
	if _, err := w.AddBot(&recordingBrain{}, nav); err == nil || len(w.Players) != MaxPlayers {
		t.Fatal("bot exceeded player capacity")
	}
	w.Remove(w.Players[0].ID)
	p := addTestBot(t, w, &recordingBrain{input: core.Input{Aim: core.Vec2{X: 3, Y: 3}}})
	w.Step()
	if p.ID != MaxPlayers+1 || p.Status != "alive" {
		t.Fatal("removed bot did not release a slot")
	}
}

func TestBotLoadoutsRotateAtSpawnAcrossFullCatalog(t *testing.T) {
	w := MustNew(testcontent.Map("yard"))
	p := addTestBot(t, w, &recordingBrain{})
	primaries, secondaries := map[string]bool{}, map[string]bool{}
	for range 8 {
		if !w.Spawn(p) {
			t.Fatal("spawn failed")
		}
		e := p.State.Equipment
		if !core.IsPrimary(e.Primary) || !core.IsSecondary(e.Secondary) {
			t.Fatal("invalid loadout", e)
		}
		primaries[e.Primary], secondaries[e.Secondary] = true, true
		if w.Spawn(p) || p.State.Equipment != e {
			t.Fatal("live equipment changed")
		}
		p.Status = "dead"
		p.Died = w.Tick
		if w.Spawn(p) || p.State.Equipment != e {
			t.Fatal("respawn delay bypassed")
		}
		w.Tick += w.Rules.RespawnTicks
	}
	if len(primaries) != 8 || len(secondaries) != 3 {
		t.Fatal("incomplete catalog", primaries, secondaries)
	}
}

func TestBotSightBoundary(t *testing.T) {
	w := MustNew([]byte(`{"name":"Synthetic","schema":1,"theme":"classic","id":"synthetic","author":"Tests","width":36,"height":36,"spawns":[{"x":3,"y":3}],"walls":[]}`))
	p := addTestBot(t, w, &recordingBrain{})
	q := w.Add()
	w.Spawn(p)
	w.Spawn(q)
	q.State.X, q.State.Y = p.State.X+8, p.State.Y
	if len(w.observeBot(p).Opponents) != 1 {
		t.Fatal("boundary invisible")
	}
	q.State.X += .01
	if len(w.observeBot(p).Opponents) != 0 {
		t.Fatal("distant opponent leaked")
	}
}

func TestCTFTeammateBotContactsWhileApproaching(t *testing.T) {
	w := modeWorld(t, ModeCTF)
	human := w.Add()
	w.Spawn(human)
	brain := &recordingBrain{input: core.Input{X: -1, Aim: core.Vec2{X: 4, Y: 4}}}
	bot := addTestBot(t, w, brain)
	w.Spawn(bot)
	bot.Team = human.Team
	// Isolate body contacts from authored walls and objectives.
	human.State = core.NewPlayer(core.Vec2{X: 4, Y: 4}, 0)
	bot.State = core.NewPlayer(core.Vec2{X: 5, Y: 4}, math.Pi)
	w.Geometry = core.World{Grid: core.NewGrid(core.Wall{W: 20, H: 20}, nil)}
	w.Tick = 400
	for i := 1; i <= 120; i++ {
		if err := w.Submit(human, []Command{{Seq: i, Life: human.Life, Input: core.Input{X: 1, Aim: core.Vec2{X: 5, Y: 4}}}}); err != nil {
			t.Fatal(err)
		}
		w.Step()
		distance := math.Hypot(human.State.X-bot.State.X, human.State.Y-bot.State.Y)
		if distance < 2*core.Radius {
			t.Fatalf("tick %d: teammate bot overlap, distance=%g", w.Tick, distance)
		}
	}
	if len(brain.observations) == 0 {
		t.Fatal("bot did not run")
	}
}
