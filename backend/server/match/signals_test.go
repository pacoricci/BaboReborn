package match

import (
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

func signalCount(w *World, kind string) int {
	n := 0
	for _, event := range signalEvents(w) {
		if event.Kind == kind {
			n++
		}
	}
	return n
}

func TestWeaponSignalsFollowTransitionsWithoutChangingCooldown(t *testing.T) {
	for _, primary := range []string{"shotgun", "photon", "chain"} {
		w, p, _ := equipPair()
		p.State.Equipment = core.NewEquipment(primary, "knives")
		if primary == "shotgun" {
			p.State.Equipment.Shells = gameconfig.ShotgunShells - 1
		}
		if primary == "chain" {
			p.State.Equipment.Heat = 0
		}
		command(t, w, p, core.Input{Fire: true, Aim: core.Vec2{X: 25, Y: 20}})
		w.Step()
		for range durationTicks(gameconfig.ShotgunReloadSeconds) {
			w.Step()
		}
		switch primary {
		case "shotgun":
			if signalCount(w, "reload") != gameconfig.ShotgunShells || p.State.Equipment.Shells != 0 || p.State.Cooldown > 1e-9 {
				t.Fatal("reload stages or existing completion changed", signalEvents(w), p.State)
			}
		case "photon":
			if signalCount(w, "charge") != 1 {
				t.Fatal("charge start repeated", signalEvents(w))
			}
		case "chain":
			if signalCount(w, "overheat") != 1 {
				t.Fatal("overheat edge missing or repeated", signalEvents(w))
			}
		}
	}
}

func TestSignalsOnlyDescribeAcceptedActionsAndPickups(t *testing.T) {
	w, p, other := equipPair()
	p.State.Equipment.Secondary = "shield"
	input := core.Input{Secondary: true, Grenade: true, Aim: core.Vec2{X: 20, Y: 20}}
	for range 2 {
		command(t, w, p, input)
		w.Step()
	}
	if signalCount(w, "shield") != 1 || signalCount(w, "throw") != 0 {
		t.Fatal("rejected action sounded", signalEvents(w))
	}
	p.State.Equipment.MeleeDelay = 0
	command(t, w, p, core.Input{Grenade: true, Aim: input.Aim})
	w.Step()
	if signalCount(w, "throw") != 1 {
		t.Fatal("accepted throw missing", signalEvents(w))
	}
	w.addItem("weapon", "shotgun", core.Flight{Position: core.Vec3{X: p.State.X, Y: p.State.Y, Z: .1}})
	id := w.Items[0].ID
	w.pickup(other, id)
	if signalCount(w, "pickup-equipment") != 0 {
		t.Fatal("out-of-range pickup sounded")
	}
	w.pickup(p, id)
	w.pickup(p, id)
	if signalCount(w, "pickup-equipment") != 1 {
		t.Fatal("pickup identity was not consumed once", signalEvents(w))
	}
	w.addItem("health", "smg", core.Flight{Position: core.Vec3{X: p.State.X, Y: p.State.Y, Z: .1}})
	w.Step()
	if signalCount(w, "pickup-health") != 1 {
		t.Fatal("health pickup missing", signalEvents(w))
	}
}

func TestProjectileSignalsUseActualContactsAndStayBounded(t *testing.T) {
	w, p, _ := equipPair()
	w.Geometry.Walls = nil
	flight := core.Flight{Position: core.Vec3{X: 15, Y: 15, Z: .01}, Velocity: core.Vec3{Z: -3}}
	w.projectile("molotov", p.ID, flight)
	g := w.projectile("grenade", p.ID, flight)
	w.Step()
	if signalCount(w, "molotov-break") != 1 || signalCount(w, "bounce") != 1 {
		t.Fatal("missing impact signals", signalEvents(w))
	}
	g.Position.Z = 0
	g.Velocity = core.Vec3{}
	for range 20 {
		w.Step()
	}
	if signalCount(w, "molotov-break") != 1 || signalCount(w, "bounce") != 1 {
		t.Fatal("resting or consumed projectile repeated", signalEvents(w))
	}
	for range 200 {
		w.signal("bounce", p.ID, flight.Position)
	}
	if len(w.Cues) != 160 || w.Cues[159].ID-w.Cues[0].ID != 159 {
		t.Fatal("signal queue is not bounded and monotonic")
	}
}

func TestCoverageSignalsFollowAcceptedLifecycle(t *testing.T) {
	w, p, _ := equipPair()
	w.DrainEvents()
	if w.Spawn(p) || signalCount(w, "spawn") != 0 {
		t.Fatal("rejected spawn sounded")
	}
	p.Status, p.Died = "dead", w.Tick-w.Rules.RespawnTicks
	if !w.Spawn(p) || signalCount(w, "spawn") != 1 {
		t.Fatal("accepted respawn did not sound once")
	}
	p.State.Equipment.Protection = gameconfig.ShieldInactiveTailSeconds + gameconfig.TickSeconds/2
	p.State.Equipment.Overheated = true
	before := weaponTransitionBefore(&p.State)
	p.State.Equipment.Protection -= gameconfig.TickSeconds
	p.State.Equipment.Overheated = false
	w.weaponSignals(p, before)
	w.weaponSignals(p, weaponTransitionBefore(&p.State))
	if signalCount(w, "shield-end") != 1 || signalCount(w, "chain-ready") != 1 {
		t.Fatal("equipment edges repeated or missing", signalEvents(w))
	}
	p.State.Equipment.Primary = "photon"
	p.State.Equipment.Charge = gameconfig.PhotonChargeSeconds - gameconfig.TickSeconds
	before = weaponTransitionBefore(&p.State)
	p.State.Equipment.Charge += gameconfig.TickSeconds
	w.weaponSignals(p, before)
	w.weaponSignals(p, weaponTransitionBefore(&p.State))
	if signalCount(w, "charge-ready") != 1 {
		t.Fatal("charge completion repeated or missing")
	}
}

func TestMinibotAndFireEndOnlyOnceAndGrenadePickupIsDistinct(t *testing.T) {
	w, p, _ := equipPair()
	w.DrainEvents()
	p.State.Equipment.Secondary = "minibot"
	p.State.Equipment.SecondaryActivated = true
	w.Geometry.Walls = nil
	w.deploy(p, 0)
	w.deploy(p, 0)
	if signalCount(w, "minibot-start") != 1 {
		t.Fatal("duplicate or missing deployment")
	}
	for _, entity := range w.Projectiles {
		entity.Expires = w.Tick
	}
	f := w.projectile("flame", p.ID, core.Flight{})
	f.Expires = w.Tick
	w.updateEntities()
	w.updateEntities()
	if signalCount(w, "minibot-end") != 1 || signalCount(w, "fire-end") != 1 {
		t.Fatal("missing/repeated removal")
	}
	w.addItem("grenade", "", core.Flight{Position: core.Vec3{X: p.State.X, Y: p.State.Y}})
	w.updateEntities()
	if signalCount(w, "pickup-grenade") != 1 || signalCount(w, "pickup-equipment") != 0 {
		t.Fatal("grenade uses weapon cue")
	}
}

func TestShieldHitAndItemContactAreNotIdleSounds(t *testing.T) {
	w, p, other := equipPair()
	w.DrainEvents()
	p.body.Shield = true
	p.body.HP = p.HP - 1
	w.resolveDeaths(other.ID, "smg")
	w.resolveDeaths(other.ID, "smg")
	if signalCount(w, "shield-hit") != 1 {
		t.Fatal("shield impact repeated or missing")
	}
	w.addItem("weapon", "smg", core.Flight{Position: core.Vec3{X: 15, Y: 15, Z: .01}, Velocity: core.Vec3{Z: -3}})
	w.updateEntities()
	if len(cuesOf(w, "item-impact")) != 1 {
		t.Fatal("falling item impact missing")
	}
	w.Items[0].Position.Z = 0
	w.Items[0].Velocity = core.Vec3{}
	w.updateEntities()
	if len(cuesOf(w, "item-impact")) != 1 {
		t.Fatal("resting item sounded")
	}
}
