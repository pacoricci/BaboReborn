package bots

import (
	"testing"

	"baboreborn/backend/core"
)

func TestArsenalDecisions(t *testing.T) {
	for _, primary := range []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"} {
		t.Run(primary, func(t *testing.T) {
			b := NewSimple(Standard(), 1)
			o := Observation{Self: core.NewPlayer(core.Vec2{}, 0), HP: 100}
			o.Self.Equipment = core.NewEquipment(primary, "knives")
			o.Self.Equipment.Grenades, o.Self.Equipment.Molotovs = 0, 0
			input := core.Input{}
			b.combat(o, 4.5, true, &input)
			if !input.Fire {
				t.Fatal("primary not used")
			}
		})
	}
	for _, test := range []struct {
		weapon   string
		distance float64
	}{
		{"knives", .7}, {"shield", 4}, {"minibot", 4},
	} {
		t.Run(test.weapon, func(t *testing.T) {
			b := NewSimple(Standard(), 1)
			o := Observation{Time: 2, Self: core.NewPlayer(core.Vec2{}, 0), HP: 40}
			o.Self.Equipment = core.NewEquipment("smg", test.weapon)
			input := core.Input{}
			b.combat(o, test.distance, true, &input)
			if !input.Secondary || input.Grenade || input.Molotov {
				t.Fatal("missing exclusive secondary", input)
			}
			input = core.Input{}
			o.Time += .1
			b.combat(o, test.distance, true, &input)
			if input.Secondary {
				t.Fatal("deployment spam")
			}
		})
	}
}

func TestThrowWaitsForPrimaryAndUsesBothInventories(t *testing.T) {
	for _, d := range []float64{4, 6} {
		b := NewSimple(Standard(), 1)
		o := Observation{Time: 2, Self: core.NewPlayer(core.Vec2{}, 0), HP: 100}
		input := core.Input{}
		b.combat(o, d, true, &input)
		if input.Fire || input.Grenade || input.Molotov {
			t.Fatal("must first release primary during cooldown", input)
		}
		o.Self.Cooldown = 0
		b.combat(o, d, true, &input)
		if input.Fire || input.Grenade != (d == 6) || input.Molotov != (d == 4) {
			t.Fatal("missing throw", input)
		}
		o.Self.Equipment.Grenades, o.Self.Equipment.Molotovs = 0, 0
		o.Time += 4
		input = core.Input{}
		b.combat(o, d, true, &input)
		if !input.Fire || input.Grenade || input.Molotov {
			t.Fatal("empty inventory blocked primary", input)
		}
	}
}

func TestSpecialPrimaryReleaseAndReaction(t *testing.T) {
	b := NewSimple(Standard(), 1)
	o := Observation{Self: core.NewPlayer(core.Vec2{}, 0), HP: 100}
	o.Self.Equipment = core.NewEquipment("bazooka", "knives")
	o.Self.Equipment.Grenades, o.Self.Equipment.Molotovs = 0, 0
	o.Self.Equipment.RocketActive = true
	input := core.Input{}
	b.combat(o, 6, true, &input)
	if input.Fire {
		t.Fatal("premature remote detonation")
	}
	o.Self.Equipment.Primary = "flamethrower"
	o.Self.Equipment.FireTime = .8
	o.Self.Equipment.SinceShot = .1
	b.combat(o, 4, true, &input)
	if input.Fire {
		t.Fatal("flame did not rest")
	}
	o.Self.Equipment.SinceShot = .4
	b.combat(o, 4, true, &input)
	if !input.Fire {
		t.Fatal("flame did not resume")
	}
	input = core.Input{}
	b.combat(o, .5, false, &input)
	if input.Fire || input.Secondary || input.Grenade || input.Molotov {
		t.Fatal("reaction bypass", input)
	}
}

func TestTacticsExecuteThroughNormalMechanics(t *testing.T) {
	for _, weapon := range []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower", "knives", "shield", "minibot", "grenade", "molotov"} {
		t.Run(weapon, func(t *testing.T) {
			b := NewSimple(Standard(), 1)
			p := core.NewPlayer(core.Vec2{X: 10, Y: 10}, 0)
			d := 4.5
			if core.IsPrimary(weapon) {
				p.Equipment.Primary = weapon
			}
			if core.IsSecondary(weapon) {
				p.Equipment.Secondary = weapon
			}
			p.Equipment.Grenades, p.Equipment.Molotovs = 0, 0
			if weapon == "knives" {
				d = .7
			}
			if weapon == "grenade" {
				p.Equipment.Grenades = 1
				d = 6
			}
			if weapon == "molotov" {
				p.Equipment.Molotovs = 1
			}
			world := core.World{Grid: core.NewGrid(core.Wall{W: 36, H: 36}, nil)}
			seed := uint32(1)
			input := core.Input{}
			executed := false
			for tick := 0; tick < 6*120; tick++ {
				if tick%12 == 0 {
					input = core.Input{Aim: core.Vec2{X: p.X + d, Y: p.Y}}
					hp := 100.
					if weapon == "shield" {
						hp = 40
					}
					b.combat(Observation{Time: float64(tick) / 120, Self: p, HP: hp}, d, tick >= 60, &input)
				}
				shot := core.Step(&p, input, 1./120, world, nil, &seed, core.ShotGeometry{MaxDistance: 20, WallHeight: 2})
				if (shot != nil && shot.Kind == weapon) || p.Equipment.Action == weapon {
					executed = true
					break
				}
				input.Secondary, input.Grenade, input.Molotov = false, false, false
			}
			if !executed {
				t.Fatal("tactic never produced the actual weapon action")
			}
		})
	}
}
