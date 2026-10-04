package match

import (
	"math"
	"reflect"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

// The browser test covers the same synthetic sequence through Prediction.reconcile.
func TestNeutralTickReconciliationContract(t *testing.T) {
	w := MustNew(arena())
	p := w.Add()
	if !w.Spawn(p) {
		t.Fatal("synthetic player did not spawn")
	}
	w.Tick = 10
	p.lastInput = w.Tick
	p.State = core.NewPlayer(core.Vec2{X: 4, Y: 4}, 0)
	p.State.Cooldown = 0
	p.Ack, p.accepted, p.Seed = 40, 40, 1234
	initial, initialSeed := p.State, p.Seed
	consumed := []Command{
		{Seq: 41, Life: p.Life, Input: core.Input{X: 1, Aim: core.Vec2{X: 10, Y: 4}}},
		{Seq: 42, Life: p.Life, Input: core.Input{X: 1, Aim: core.Vec2{X: 10, Y: 4}}},
		{Seq: 43, Life: p.Life, Input: core.Input{Y: 1, Aim: core.Vec2{X: 10, Y: 4}}},
	}
	pending := []Command{
		{Seq: 44, Life: p.Life, Input: core.Input{X: -1, Fire: true, Aim: core.Vec2{X: 10, Y: 4}}},
		{Seq: 45, Life: p.Life, Input: core.Input{Y: -1, Aim: core.Vec2{X: 10, Y: 4}}},
	}
	authoritative, authoritativeSeed := initial, initialSeed
	commandIndex := 0
	for slot := 0; slot < 4; slot++ {
		input := core.Input{
			Aim: core.Vec2{
				X: authoritative.X + math.Cos(authoritative.Angle)*2,
				Y: authoritative.Y + math.Sin(authoritative.Angle)*2,
			},
		}
		ack := p.Ack
		if slot != 2 {
			command := consumed[commandIndex]
			commandIndex++
			if err := w.Submit(p, []Command{command}); err != nil {
				t.Fatal(err)
			}
			input = command.Input
		}
		w.Step()
		core.Step(&authoritative, input, gameconfig.TickSeconds, w.Geometry, nil, &authoritativeSeed, Geometry)
		if slot == 2 && p.Ack != ack {
			t.Fatal("neutral tick acknowledged an input")
		}
	}
	compareNeutralState(t, p.State, authoritative)
	if p.Seed != authoritativeSeed || p.Ack != 43 || p.PendingInputs() != 0 {
		t.Fatal("input/seed contract changed")
	}
	predicted, predictedSeed := initial, initialSeed
	for _, command := range consumed {
		core.Step(&predicted, command.Input, gameconfig.TickSeconds, w.Geometry, nil, &predictedSeed, Geometry)
	}
	for _, command := range pending {
		core.Step(&predicted, command.Input, gameconfig.TickSeconds, w.Geometry, nil, &predictedSeed, Geometry)
	}
	replayed, replaySeed := authoritative, authoritativeSeed
	for _, command := range pending {
		core.Step(&p.State, command.Input, gameconfig.TickSeconds, w.Geometry, nil, &p.Seed, Geometry)
		core.Step(&replayed, command.Input, gameconfig.TickSeconds, w.Geometry, nil, &replaySeed, Geometry)
	}
	compareNeutralState(t, p.State, replayed)
	if p.Seed != replaySeed || p.Seed == authoritativeSeed {
		t.Fatal("pending replay did not reset and advance the seed")
	}
	if correction := math.Hypot(p.State.X-predicted.X, p.State.Y-predicted.Y); correction <= 0 {
		t.Fatal("neutral tick did not produce a reconciliation correction")
	}
}

func compareNeutralState(t *testing.T, actual, expected core.Player) {
	t.Helper()
	var compare func(reflect.Value, reflect.Value)
	compare = func(a, b reflect.Value) {
		switch a.Kind() {
		case reflect.Struct:
			for i := 0; i < a.NumField(); i++ {
				compare(a.Field(i), b.Field(i))
			}
		case reflect.Float64:
			if math.Abs(a.Float()-b.Float()) > 1e-12 {
				t.Fatalf("state differs: %.17g != %.17g", a.Float(), b.Float())
			}
		default:
			if !reflect.DeepEqual(a.Interface(), b.Interface()) {
				t.Fatalf("state differs: %v != %v", a, b)
			}
		}
	}
	compare(reflect.ValueOf(actual), reflect.ValueOf(expected))
}
