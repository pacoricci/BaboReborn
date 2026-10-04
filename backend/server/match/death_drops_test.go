package match

import (
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

func TestDeathDropDensity(t *testing.T) {
	for _, count := range []int{0, 20, 35, 49, 50} {
		w, p, _ := equipPair()
		p.State.Equipment.Grenades = gameconfig.GrenadeMaxCarry
		for range count {
			w.addItem("health", "", core.Flight{})
		}
		const attempts = 2000
		total := 0
		for range attempts {
			seed := w.seed
			w.drop(p)
			dropped := len(w.Items) - count
			if len(w.Items) > gameconfig.PickupsMaxItems {
				t.Fatalf("count %d: exceeded item cap", count)
			}
			if count <= gameconfig.PickupsGuaranteedDropItems && dropped != 5 {
				t.Fatalf("count %d: guaranteed drops = %d, want 5", count, dropped)
			}
			if count == gameconfig.PickupsMaxItems && w.seed != seed {
				t.Fatal("full world consumed random numbers")
			}
			total += dropped
			w.Items = w.Items[:count]
		}
		// Fixed-seed sampling catches missing or incorrectly scaled probability.
		if count == 35 && (total < 4500 || total > 5500) {
			t.Fatalf("midpoint: %d drops, want approximately 5000", total)
		}
		if count == 49 && (total < 200 || total > 450) {
			t.Fatalf("near cap: %d drops, want approximately 312", total)
		}
	}
}

func TestDeathDropsResumeAfterExpiry(t *testing.T) {
	w, p, _ := equipPair()
	for range gameconfig.PickupsMaxItems {
		w.addItem("health", "", core.Flight{})
	}
	w.Tick += durationTicks(gameconfig.PickupsHealthSeconds)
	w.updateEntities()
	if len(w.Items) != 0 {
		t.Fatal("expired items still occupy capacity")
	}
	w.drop(p)
	if len(w.Items) != 2+p.State.Equipment.Grenades {
		t.Fatal("drops did not resume after expiry")
	}
}

func TestWeaponSwapAtItemCap(t *testing.T) {
	w, p, _ := equipPair()
	position := core.Flight{Position: core.Vec3{X: p.State.X, Y: p.State.Y}}
	w.addItem("weapon", "shotgun", position)
	itemID := w.Items[0].ID
	oldPrimary := p.State.Equipment.Primary
	for len(w.Items) < gameconfig.PickupsMaxItems {
		w.addItem("health", "", core.Flight{})
	}
	w.pickup(p, itemID)
	if p.State.Equipment.Primary != "shotgun" || len(w.Items) != gameconfig.PickupsMaxItems {
		t.Fatal("swap failed or changed item count at cap")
	}
	replacement := w.Items[len(w.Items)-1]
	if replacement.Kind != "weapon" || replacement.Primary != oldPrimary || replacement.ID == itemID {
		t.Fatal("swap lost the replaced primary")
	}
}
