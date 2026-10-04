// Motion-conformance exposes only the pure kinematic kernel to the parity suite.
package main

import (
	"encoding/json"
	"log"
	"os"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

type scenario struct {
	Flight core.Flight
	Mode   string
	Walls  []core.Wall
	Height float64
	Steps  int
}
type frame struct {
	Flight core.Flight `json:"flight"`
	Normal *core.Vec3  `json:"normal"`
}

func main() {
	var scenarios []scenario
	if err := json.NewDecoder(os.Stdin).Decode(&scenarios); err != nil {
		log.Fatal(err)
	}
	results := make([][]frame, len(scenarios))
	for i, s := range scenarios {
		if s.Steps < 0 || s.Steps > 2400 {
			log.Fatal("Invalid step count")
		}
		for range s.Steps {
			var normal *core.Vec3
			if s.Mode == "rocket" {
				core.StepRocket(&s.Flight, gameconfig.TickSeconds)
			} else {
				normal = core.StepFlight(&s.Flight, gameconfig.TickSeconds, s.Walls, s.Height, s.Mode == "bounce")
			}
			results[i] = append(results[i], frame{Flight: s.Flight, Normal: normal})
			if s.Mode == "fall" && normal != nil {
				break
			}
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(results); err != nil {
		log.Fatal(err)
	}
}
