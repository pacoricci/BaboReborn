package match

import (
	"math"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

func equipPair() (*World, *Player, *Player) {
	w, a, b := alivePair()
	a.State.Equipment = core.NewEquipment("smg", "knives")
	b.State.Equipment = core.NewEquipment("smg", "knives")
	a.body = core.Body{ID: a.ID, X: a.State.X, Y: a.State.Y, Radius: .25, HP: 100}
	b.body = core.Body{ID: b.ID, X: b.State.X, Y: b.State.Y, Radius: .25, HP: 100}
	w.Tick = 500
	a.State.Cooldown = 0
	b.State.Cooldown = 0
	return w, a, b
}
func command(t *testing.T, w *World, p *Player, input core.Input) {
	t.Helper()
	if err := w.Submit(p, []Command{{Seq: p.accepted + 1, Life: p.Life, Input: input}}); err != nil {
		t.Fatal(err)
	}
}
func TestEquipmentSelectionSpawnAndContestedSwap(t *testing.T) {
	w, a, b := equipPair()
	if err := w.Select(a, "shotgun", "shield"); err != nil {
		t.Fatal(err)
	}
	if a.State.Equipment.Primary != "smg" || a.State.Equipment.Secondary != "knives" {
		t.Fatal("selection changed current life")
	}
	if w.Select(a, "unknown", "shield") == nil {
		t.Fatal("unsupported catalog")
	}
	b.State.X = a.State.X
	b.State.Y = a.State.Y
	a.Born = w.Tick
	b.Born = w.Tick
	w.addItem("weapon", "shotgun", core.Flight{Position: core.Vec3{X: a.State.X, Y: a.State.Y, Z: .1}})
	id := w.Items[0].ID
	command(t, w, a, core.Input{Aim: core.Vec2{X: 10, Y: 4}, Pickup: id})
	command(t, w, b, core.Input{Aim: core.Vec2{X: 10, Y: 4}, Pickup: id})
	w.Step()
	if a.State.Equipment.Primary != "shotgun" || b.State.Equipment.Primary != "smg" || a.State.Cooldown != 1 || len(w.Items) != 1 || w.Items[0].ID == id || w.Items[0].Primary != "smg" {
		t.Fatal("non-atomic swap")
	}
	a.Status = "dead"
	a.Died = w.Tick - gameconfig.TickHz
	if !w.Spawn(a) || a.State.Equipment.Primary != "shotgun" || a.State.Equipment.Secondary != "shield" || a.State.Equipment.Grenades != 2 || a.State.Equipment.Molotovs != 1 {
		t.Fatal("spawn loadout")
	}
}
func TestPickupsSingleOwnerCapsExpiryAndDeathDrops(t *testing.T) {
	w, a, b := equipPair()
	a.HP = 10
	a.body.HP = 10
	a.State.Equipment.Grenades = 2
	b.State.X = a.State.X
	b.State.Y = a.State.Y
	a.Born = w.Tick
	b.Born = w.Tick
	flight := core.Flight{Position: core.Vec3{X: a.State.X, Y: a.State.Y, Z: .1}}
	w.addItem("health", "smg", flight)
	w.addItem("grenade", "smg", flight)
	w.addItem("grenade", "smg", flight)
	w.Step()
	if a.HP != 60 || a.State.Equipment.Grenades != 3 || b.State.Equipment.Grenades != 2 || len(w.Items) != 0 {
		t.Fatal("pickup ownership/caps")
	}
	a.body.HP = 0
	w.resolveDeaths(a.ID, "smg")
	if a.Score != -1 || a.Kills != -1 || a.Deaths != 1 || len(w.Items) != 5 {
		t.Fatal("suicide drops/scoring")
	}
	counts := map[string]int{}
	for _, item := range w.Items {
		counts[item.Kind]++
		expected := 30
		if item.Kind == "health" {
			expected = 20
		}
		if item.Kind == "grenade" {
			expected = 25
		}
		if item.Expires-w.Tick != expected*gameconfig.TickHz {
			t.Fatal("expiry")
		}
	}
	if counts["weapon"] != 1 || counts["health"] != 1 || counts["grenade"] != 3 {
		t.Fatal(counts)
	}
	w.resolveDeaths(a.ID, "smg")
	if a.Deaths != 1 {
		t.Fatal("death counted twice")
	}
	w.Tick += 30 * gameconfig.TickHz
	b.State.X = 16
	b.State.Y = 16
	w.Step()
	if len(w.Items) != 0 {
		t.Fatal("expired drops survived")
	}
}
func TestScoreLimitIntermissionFrozenRankingAndNextRound(t *testing.T) {
	w, a, b := equipPair()
	w.Rules.ScoreLimit = 1
	b.body.HP = 0
	w.resolveDeaths(a.ID, "smg")
	w.Step()
	if w.Match.Phase != "intermission" || len(w.Match.Ranking) != 2 || w.Match.Ranking[0].ID != a.ID || a.Score != 1 {
		t.Fatal("score limit")
	}
	if w.Spawn(b) || w.Spawn(w.Add()) {
		t.Fatal("spawn during final scores")
	}
	command(t, w, a, core.Input{X: 1, Fire: true, Aim: core.Vec2{X: 10, Y: 4}})
	state := a.State
	w.Step()
	if a.State.X != state.X || len(a.queue) != 0 {
		t.Fatal("intermission input")
	}
	w.Remove(a.ID)
	if w.Match.Ranking[0].ID != a.ID {
		t.Fatal("departure mutated final scores")
	}
	w.Tick = w.Match.Ends - 1
	w.Step()
	if w.Match.Round != 2 || w.Match.Phase != "playing" || b.Score != 0 || b.Deaths != 0 || b.HP != 0 || len(w.Items) != 0 || len(w.Projectiles) != 0 {
		t.Fatal("round reset")
	}
	if !w.Spawn(b) {
		t.Fatal("manual next-round spawn unavailable")
	}
}
func TestTimeLimitTieAndDisabledLimits(t *testing.T) {
	w, _, _ := equipPair()
	w.Rules.TimeLimitTicks = w.Tick + 1
	w.Step()
	if w.Match.Phase != "intermission" || w.Match.Ranking[0].Score != w.Match.Ranking[1].Score {
		t.Fatal("tie should finish")
	}
	w = MustNew(arena())
	a := w.Add()
	w.Spawn(a)
	a.Score = 100
	w.Rules.ScoreLimit = 0
	w.Rules.TimeLimitTicks = 0
	w.Tick = 999999
	w.Step()
	if w.Match.Phase != "playing" {
		t.Fatal("disabled limit")
	}
}
func TestKnivesShieldAndAreaOcclusion(t *testing.T) {
	w, a, b := equipPair()
	b.State.X = 4.7
	b.State.Y = 4
	a.Born = w.Tick
	b.Born = 0
	command(t, w, a, core.Input{Secondary: true, Aim: core.Vec2{X: 7, Y: 4}})
	w.Step()
	if b.HP != 40 || a.HP != 100 {
		t.Fatalf("knife radius damage %v %v", a.HP, b.HP)
	}
	w, a, b = equipPair()
	b.State.X = 4.7
	b.State.Y = 4
	b.State.Equipment.Protection = 2
	command(t, w, a, core.Input{Secondary: true, Aim: core.Vec2{X: 7, Y: 4}})
	w.Step()
	if b.HP != 70 {
		t.Fatalf("shield should halve: %v", b.HP)
	}
	w.Geometry.Walls = []core.Wall{{X: 5, Y: 3, W: 1, H: 3}}
	a.body = core.Body{ID: a.ID, X: 4, Y: 4, Radius: .25, HP: 100}
	b.body = core.Body{ID: b.ID, X: 7, Y: 4, Radius: .25, HP: 100}
	w.damageArea(a.ID, core.Vec3{X: 4, Y: 4, Z: .25}, 4, 150, false, false, "grenade")
	if b.HP != 100 {
		t.Fatal("area through cover")
	}
}
func TestGrenadeFuseSelfDamageAndMolotovFlames(t *testing.T) {
	w, a, b := equipPair()
	a.Born = 0
	b.Born = 0
	b.State.X = 16
	b.State.Y = 16
	grenade := w.projectile("grenade", a.ID, core.Flight{Position: core.Vec3{X: 4, Y: 4, Z: .01}})
	w.Tick = grenade.Expires - 2
	w.Step()
	if a.HP != 100 {
		t.Fatal("early fuse")
	}
	w.Step()
	if a.Status != "dead" || a.Score != -1 || len(w.Projectiles) != 0 {
		t.Fatal("grenade authority/self damage")
	}
	w, a, b = equipPair()
	b.State.X = 16
	b.State.Y = 16
	w.projectile("molotov", a.ID, core.Flight{Position: core.Vec3{X: 8, Y: 8, Z: .001}, Velocity: core.Vec3{Z: -1}})
	w.Step()
	if len(w.Projectiles) != 2 || w.Projectiles[0].Kind != "flame" {
		t.Fatal("Molotov should create two flames")
	}
	f := w.Projectiles[0]
	b.State.X = f.Position.X
	b.State.Y = f.Position.Y
	w.Step()
	if f.Attached != b.ID {
		t.Fatal("flame did not attach")
	}
	// Once attached, it follows until three seconds, then cannot reattach for one second.
	b.State.X = 10
	w.Step()
	if f.Position.X != 10 {
		t.Fatal("flame follow")
	}
	until := f.stickUntil
	w.Tick = until - 1
	w.Step()
	if f.Attached != 0 || f.stickUntil != w.Tick+gameconfig.TickHz {
		t.Fatal("flame detach")
	}
	w.Remove(a.ID)
	w.Step()
	if len(w.Projectiles) != 0 {
		t.Fatal("disconnected owner effects retained")
	}
}
func TestFlightGravityBounceAndShieldThreshold(t *testing.T) {
	f := core.Flight{Position: core.Vec3{X: 4, Y: 4, Z: .001}, Velocity: core.Vec3{X: 2, Z: -1}}
	normal := core.StepFlight(&f, gameconfig.TickSeconds, nil, .7, true)
	if normal == nil || math.Abs(f.Velocity.X-1.3) > 1e-10 || f.Velocity.Z <= 0 {
		t.Fatal("bounce")
	}
	body := core.Body{HP: 100, Shield: true}
	core.ApplyDamage(&body, 60)
	if body.HP != 70 {
		t.Fatal("shield")
	}
	body.Immune = true
	core.ApplyDamage(&body, 100)
	if body.HP != 70 {
		t.Fatal("immunity")
	}
	w, a, b := equipPair()
	b.State.X = 4.7
	b.State.Y = 4
	b.State.Equipment.Protection = .6
	command(t, w, a, core.Input{Secondary: true, Aim: core.Vec2{X: 7, Y: 4}})
	w.Step()
	if b.HP != 40 {
		t.Fatal("shield threshold")
	}
}

func TestThrownGrenadeBouncesThenDamagesAndPublishesExplosion(t *testing.T) {
	w, a, b := equipPair()
	a.Born = 0
	b.Born = 0
	b.State.X = 2.5
	b.State.Y = 4
	w.Geometry.Walls = []core.Wall{{X: 6, Y: 3, W: 1, H: 3, Height: 3}}
	command(t, w, a, core.Input{Grenade: true, Aim: core.Vec2{X: 10, Y: 4}})
	w.Step()
	if len(w.Projectiles) != 1 || a.State.Equipment.Grenades != 1 {
		t.Fatal("throw was not accepted")
	}
	bounced := false
	expires := w.Projectiles[0].Expires
	for w.Tick < expires {
		w.Step()
		if w.Tick < expires {
			if b.HP != 100 {
				t.Fatal("damage before fuse")
			}
			if w.Projectiles[0].Velocity.X < 0 {
				bounced = true
			}
		}
	}
	if !bounced || b.HP >= 100 {
		t.Fatalf("bounce %v, victim HP %v", bounced, b.HP)
	}
	if len(w.Projectiles) != 0 || len(effectEvents(w)) != 1 || effectEvents(w)[0].Kind != "explosion" || !hasHit(w) {
		t.Fatal("missing authoritative explosion", effectEvents(w))
	}
}

func TestShieldCommandHalvesSubsequentKnifeDamage(t *testing.T) {
	w, shield, attacker := equipPair()
	shield.State.Equipment.Secondary = "shield"
	attacker.State.X = 4.7
	attacker.State.Y = 4
	command(t, w, shield, core.Input{Secondary: true, Aim: core.Vec2{X: 7, Y: 4}})
	w.Step()
	command(t, w, attacker, core.Input{Secondary: true, Aim: core.Vec2{X: 4, Y: 4}})
	w.Step()
	if shield.HP != 70 || shield.State.Equipment.Protection <= .6 || shield.State.Equipment.MeleeDelay <= 2 {
		t.Fatalf("shield command failed: HP=%v equipment=%+v", shield.HP, shield.State.Equipment)
	}
	if len(effectEvents(w)) != 1 || !hasHit(w) {
		t.Fatal("knife damage was not confirmed")
	}
}
