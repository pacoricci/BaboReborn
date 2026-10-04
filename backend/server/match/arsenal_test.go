package match

import (
	"math"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

func TestFullCatalogSelectionDropAndSwap(t *testing.T) {
	for _, primary := range []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"} {
		for _, secondary := range []string{"knives", "shield", "minibot"} {
			w, a, b := equipPair()
			if err := w.Select(a, primary, secondary); err != nil {
				t.Fatal(err)
			}
			if a.State.Equipment.Primary != "smg" {
				t.Fatal("changed live equipment")
			}
			a.Status = "dead"
			a.Died = w.Tick - 120
			if !w.Spawn(a) || a.State.Equipment.Primary != primary || a.State.Equipment.Secondary != secondary {
				t.Fatal(primary, secondary, a.State)
			}
			w.drop(a)
			var item *Item
			for _, v := range w.Items {
				if v.Kind == "weapon" {
					item = v
				}
			}
			if item == nil || item.Primary != primary {
				t.Fatal("missing dropped primary")
			}
			b.State.X = item.Position.X
			b.State.Y = item.Position.Y
			b.State.Equipment.Charge = .4
			b.State.Equipment.Heat = .1
			b.State.Equipment.Overheated = true
			w.pickup(b, item.ID)
			if b.State.Equipment.Primary != primary || b.State.Equipment.Charge != 0 || b.State.Equipment.Heat != 1 || b.State.Equipment.Overheated || b.State.Cooldown != 1 {
				t.Fatal("pickup/reset", b.State)
			}
		}
	}
}
func TestRocketFlightRemoteAndCover(t *testing.T) {
	w, a, b := equipPair()
	a.State.X = 4
	a.State.Y = 4
	b.State.X = 9
	b.State.Y = 4
	a.State.Equipment = core.NewEquipment("bazooka", "knives")
	a.State.Cooldown = 0
	a.State.Angle = 0
	command(t, w, a, core.Input{Aim: core.Vec2{X: 14, Y: 4}, Fire: true})
	w.Step()
	if len(w.Projectiles) != 1 || w.Projectiles[0].Kind != "rocket" || b.HP != 100 {
		t.Fatal("launch or instant damage")
	}
	r := w.Projectiles[0]
	start := r.Position.X
	for range 29 {
		w.Step()
	}
	if r.Position.X <= start || math.Hypot(r.Velocity.X, r.Velocity.Y) <= gameconfig.BazookaSpeed {
		t.Fatal("no acceleration")
	}
	command(t, w, a, core.Input{Aim: core.Vec2{X: 14, Y: 4}, Fire: true})
	w.Step()
	if len(w.Projectiles) != 0 || a.State.Equipment.RocketActive || len(effectEvents(w)) == 0 {
		t.Fatal("remote detonation", len(w.Projectiles), a.State.Equipment, effectEvents(w))
	}
	// Detonation on one side of cover must not hit a player on the other side.
	w, a, b = equipPair()
	w.Geometry.Walls = []core.Wall{{X: 6, Y: 0, W: 1, H: 12, Height: 3}}
	b.State.X = 7.2
	b.State.Y = 4
	b.body = core.Body{ID: b.ID, X: 7.2, Y: 4, Radius: .25, HP: 100}
	r = w.projectile("rocket", a.ID, core.Flight{Position: core.Vec3{X: 5.99, Y: 4, Z: .25}})
	w.explode(r, 2, 85)
	if b.HP != 100 {
		t.Fatal("rocket damage crossed cover", b.HP)
	}
}
func TestRocketWallAndPlayerImpact(t *testing.T) {
	for _, wall := range []bool{false, true} {
		w, a, b := equipPair()
		b.State.X = 6
		b.State.Y = 4
		if wall {
			w.Geometry.Walls = []core.Wall{{X: 6, Y: 0, W: 1, H: 12, Height: 3}}
			b.State.X = 8
		}
		r := w.projectile("rocket", a.ID, core.Flight{Position: core.Vec3{X: 4, Y: 4, Z: .25}, Velocity: core.Vec3{X: 2.5}})
		r.ownerLife = a.Life
		r.Expires = w.Tick + 2400
		for i := 0; i < 120 && len(w.Projectiles) > 0; i++ {
			w.Step()
		}
		if len(w.Projectiles) > 0 || len(effectEvents(w)) == 0 {
			t.Fatal("missed collision", wall)
		}
		if !wall && b.HP >= 100 {
			t.Fatal("no contact damage")
		}
	}
}
func TestUnknownSecondaryCannotBeSelected(t *testing.T) {
	w, a, _ := equipPair()
	primary, secondary := a.NextPrimary, a.NextSecondary
	if err := w.Select(a, "sniper", "unknown"); err == nil {
		t.Fatal("unknown secondary was accepted")
	}
	if a.NextPrimary != primary || a.NextSecondary != secondary {
		t.Fatal("invalid selection changed the next loadout")
	}
}

func TestMinibotRemovedOnOwnerDeath(t *testing.T) {
	w, a, _ := equipPair()
	bot := w.projectile("minibot", a.ID, core.Flight{})
	bot.Expires = w.Tick + 600
	a.Status = "dead"
	w.Step()
	if len(effectEvents(w)) != 0 || len(shotEvents(w)) != 0 || len(w.Projectiles) != 0 {
		t.Fatal("dead owner's turret survived or fired")
	}
}

func TestPhotonPersistentPulsesAndOcclusion(t *testing.T) {
	w, a, b := equipPair()
	a.State.X = 4
	a.State.Y = 4
	b.State.X = 8
	b.State.Y = 4
	shot := &core.Shot{Kind: "photon", From: core.Vec3{X: 4.3, Y: 4, Z: .25}, To: core.Vec3{X: 12, Y: 4, Z: .25}}
	w.primaryShot(a, shot)
	for range 11 {
		w.Step()
	}
	if b.HP != 100 {
		t.Fatal("early pulse")
	}
	w.Step()
	first := b.HP
	if first >= 100 {
		t.Fatal("missing pulse")
	}
	b.State.Y = 7
	for range 12 {
		w.Step()
	}
	if b.HP != first {
		t.Fatal("beam followed target")
	}
	b.State.Y = 4
	for range 96 {
		w.Step()
	}
	if len(w.Projectiles) != 0 || b.HP >= first {
		t.Fatal("pulse lifetime")
	}
}
func TestMinibotStationarySingleInstanceOcclusionAndExpiry(t *testing.T) {
	w, a, b := equipPair()
	a.State.X = 4
	a.State.Y = 4
	b.State.X = 7
	b.State.Y = 4
	a.State.Equipment = core.NewEquipment("smg", "minibot")
	command(t, w, a, core.Input{Aim: core.Vec2{X: 10, Y: 4}, Secondary: true})
	w.Step()
	if len(w.Projectiles) != 1 || w.Projectiles[0].Kind != "minibot" || w.Projectiles[0].Position.X != 5 {
		t.Fatal("deployment")
	}
	bot := w.Projectiles[0]
	pos := bot.Position
	for range 300 {
		w.Step()
	}
	if bot.Position != pos || b.HP >= 100 {
		t.Fatal("stationary turret did not hit", b.HP)
	}
	command(t, w, a, core.Input{Aim: core.Vec2{X: 10, Y: 4}, Secondary: true})
	w.Step()
	if len(w.Projectiles) != 1 {
		t.Fatal("duplicate turret")
	}
	for range 300 {
		w.Step()
	}
	if len(w.Projectiles) != 0 {
		t.Fatal("expiry")
	}
	w, a, b = equipPair()
	w.Geometry.Walls = []core.Wall{{X: 6, Y: 0, W: 1, H: 12, Height: 3}}
	b.State.X = 8
	b.State.Y = 4
	bot = w.projectile("minibot", a.ID, core.Flight{Position: core.Vec3{X: 5, Y: 4, Z: .15}})
	bot.nextDamage = w.Tick
	bot.Expires = w.Tick + 600
	for range 120 {
		w.Step()
	}
	if b.HP != 100 || len(shotEvents(w)) != 0 {
		t.Fatal("turret sees through cover")
	}
}
func TestOffensiveEntityCleanupAndRocketLifeIsolation(t *testing.T) {
	w, a, _ := equipPair()
	r := w.projectile("rocket", a.ID, core.Flight{})
	r.ownerLife = a.Life - 1
	a.State.Equipment.RocketActive = true
	w.explode(r, 2, 0)
	if !a.State.Equipment.RocketActive {
		t.Fatal("old life cleared new rocket")
	}
	for _, kind := range []string{"rocket", "photon", "minibot"} {
		w.projectile(kind, a.ID, core.Flight{})
	}
	w.Remove(a.ID)
	w.Step()
	if len(w.Projectiles) != 0 {
		t.Fatal("owner departure left entities")
	}
}

func TestTurretPresentationFollowsAuthorityAndDoesNotTrackThroughCover(t *testing.T) {
	w, a, b := equipPair()
	a.State.X = 4
	a.State.Y = 4
	b.State.X = 5
	b.State.Y = 7
	// Synchronize damage bodies, just as updateEntities does before turret decisions.
	b.body.X = b.State.X
	b.body.Y = b.State.Y
	bot := w.projectile("minibot", a.ID, core.Flight{Position: core.Vec3{X: 5, Y: 4, Z: .15}})
	w.Tick = 120
	w.turret(bot)
	if math.Abs(bot.Turret.Angle-math.Pi/2) > 1e-9 || bot.Turret.LastShot != 120 {
		t.Fatal("missing authority pose", bot.Turret)
	}
	saved := *bot.Turret
	w.Geometry.Walls = []core.Wall{{X: 4, Y: 5, W: 4, H: 1, Height: 3}}
	b.State.X = 7
	b.State.Y = 8
	w.Tick = 150
	w.turret(bot)
	if *bot.Turret != saved {
		t.Fatal("tracked occluded target", bot.Turret)
	}
}
