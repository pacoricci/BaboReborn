// Arsenal wire verification tool. Outputs real authority snapshots for the TS decoder.
package main

import (
	"encoding/json"
	"os"

	"baboreborn/backend/core"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/wire"
)

func main() {
	encoder := json.NewEncoder(os.Stdout)
	for _, primary := range []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"} {
		w := match.MustNew([]byte(`{"name":"Wire test","schema":1,"theme":"classic","id":"synthetic","author":"Tests","width":36,"height":36,"walls":[],"spawns":[{"x":4,"y":4},{"x":10,"y":4}]}`))
		a, b := w.Add(), w.Add()
		if err := w.Select(a, primary, "minibot"); err != nil {
			panic(err)
		}
		w.Spawn(a)
		w.Spawn(b)
		seq := 0
		for tick := 0; tick < 900; tick++ {
			seq++
			input := core.Input{Aim: core.Vec2{X: b.State.X, Y: b.State.Y}, Fire: (tick >= 125 && tick < 240) || (tick >= 480 && tick < 690), Secondary: tick == 300, Grenade: tick == 700, Molotov: tick == 825}
			if err := w.Submit(a, []match.Command{{Seq: seq, Life: a.Life, Input: input}}); err != nil {
				panic(err)
			}
			w.Step()
			if tick%4 == 0 {
				events := wire.CaptureRequiredEvents(w)
				events.Cues = wire.CaptureCues(w)
				for _, body := range []any{wire.Capture(w).ForRecipient(1), events} {
					if err := encoder.Encode(body); err != nil {
						panic(err)
					}
				}
				w.DrainEvents()
			}
		}
	}
}
