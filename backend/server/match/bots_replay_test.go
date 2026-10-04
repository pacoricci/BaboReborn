package match_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
	"baboreborn/backend/server/wire"
)

func TestBotsFightEachOtherAndReplayOnYard(t *testing.T) {
	run := func() []byte {
		w := match.MustNew(testcontent.Map("yard"))
		w.Rules.ScoreLimit = 0
		w.Rules.TimeLimitTicks = 0
		nav := navigation.New(w.Geometry.Grid)
		for i := 0; i < 4; i++ {
			if _, err := w.AddBot(bots.NewSimple(bots.Standard(), uint32(9109+i)), nav); err != nil {
				t.Fatal(err)
			}
		}
		shots := 0
		visited := map[[3]int]bool{}
		for range 120 * gameconfig.TickHz {
			w.Step()
			for _, cue := range w.Cues {
				if cue.Kind == "shot" {
					shots++
				}
			}
			w.DrainEvents()
			for _, p := range w.Players {
				visited[[3]int{p.ID, int(p.State.X), int(p.State.Y)}] = true
			}
		}
		kills := 0
		for _, p := range w.Players {
			kills += p.Kills
		}
		if shots < 100 || kills < 4 || len(visited) < 100 {
			t.Fatalf("insufficient autonomous combat: shots=%d kills=%d visited=%d", shots, kills, len(visited))
		}
		t.Logf("Yard / 4 bots / 120 simulated seconds: shots=%d kills=%d visited=%d", shots, kills, len(visited))
		out, err := json.Marshal(wire.Capture(w))
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	if !reflect.DeepEqual(run(), run()) {
		t.Fatal("seeded server replay diverged")
	}
}

func TestCTFBotNavigatesTakesAndCapturesWithOrdinaryInputs(t *testing.T) {
	for _, data := range testcontent.Maps() {
		name := match.MustNew(data).Arena.ID
		t.Run(name, func(t *testing.T) {
			run := func() []byte {
				w := match.MustNew(data)
				r := match.DefaultRules()
				r.Mode = match.ModeCTF
				r.ScoreLimit = 0
				r.TimeLimitTicks = 0
				if err := w.Configure(r); err != nil {
					t.Fatal(err)
				}
				nav := navigation.New(w.Geometry.Grid)
				if _, err := w.AddBot(bots.NewSimple(bots.Standard(), 9109), nav); err != nil {
					t.Fatal(err)
				}
				for range 90 * gameconfig.TickHz {
					w.Step()
				}
				if w.Match.Scores.Blue < 1 {
					t.Fatalf("bot did not capture: %+v flags=%+v", w.Players[0].State, w.Flags)
				}
				t.Logf("%s / one bot / 90 simulated seconds: %d captures", name, w.Match.Scores.Blue)
				b, err := json.Marshal(wire.Capture(w))
				if err != nil {
					t.Fatal(err)
				}
				return b
			}
			if !reflect.DeepEqual(run(), run()) {
				t.Fatal("CTF replay diverged")
			}
		})
	}
}
