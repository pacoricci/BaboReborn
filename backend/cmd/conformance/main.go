// Executes the shared reference inputs; the TypeScript runner checks both languages.
package main

import (
	"encoding/json"
	"os"

	"baboreborn/backend/core"
)

type suite struct {
	GridBounds   core.Wall
	RandomSeed   uint32
	ShotGeometry core.ShotGeometry
	Cases        []struct {
		ID       string
		DT       float64
		Initial  core.Player
		Walls    []core.Wall
		Segments []struct {
			Ticks int
			Input core.Input
		}
		Checkpoints []struct{ Tick int }
	}
}

func main() {
	var s suite
	if err := json.NewDecoder(os.Stdin).Decode(&s); err != nil {
		panic(err)
	}
	results := []any{}
	for _, c := range s.Cases {
		p, seed := c.Initial, s.RandomSeed
		// Reference movement cases omit inventory; adapt test data, not the mechanics.
		if p.Equipment.Primary == "" {
			p.Equipment = core.NewEquipment("smg", "knives")
		}
		w := core.World{Walls: c.Walls, Grid: core.NewGrid(s.GridBounds, c.Walls)}
		tick, shots, ci := 0, 0, 0
		checks := []any{}
		for _, segment := range c.Segments {
			for i := 0; i < segment.Ticks; i++ {
				shot := core.Step(&p, segment.Input, c.DT, w, nil, &seed, s.ShotGeometry)
				if shot != nil {
					shots++
				}
				tick++
				if ci < len(c.Checkpoints) && tick == c.Checkpoints[ci].Tick {
					checkpoint := p
					checks = append(checks, map[string]any{"tick": tick, "state": checkpoint, "shots": shots, "seed": seed, "shot": shot})
					ci++
				}
			}
		}
		results = append(results, map[string]any{"id": c.ID, "checkpoints": checks})
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		panic(err)
	}
}
