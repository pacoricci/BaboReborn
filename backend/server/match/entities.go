package match

import (
	"math"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

type Item struct {
	motion  core.Motion
	ID      int
	Kind    string
	Primary string
	Expires int
	core.Flight
}

// TurretPresentation mirrors decisions already made by the authority; clients never choose targets.
type TurretPresentation struct {
	Angle    float64
	LastShot int
}
type Projectile struct {
	motion        core.Motion
	motionCarrier int
	Turret        *TurretPresentation
	ID            int
	Kind          string
	Owner         int
	Born          int
	Expires       int
	Attached      int
	core.Flight
	ownerLife  int
	end        core.Vec3
	locked     bool
	stickUntil int
	nextDamage int
}

func (w *World) addItem(kind, primary string, flight core.Flight) {
	lifetime := gameconfig.PickupsWeaponSeconds
	if kind == "grenade" {
		lifetime = gameconfig.PickupsGrenadeSeconds
	}
	if kind == "health" {
		lifetime = gameconfig.PickupsHealthSeconds
	}
	w.entityID++
	w.Items = append(w.Items, &Item{ID: w.entityID, Kind: kind, Primary: primary, Expires: w.Tick + durationTicks(lifetime), Flight: flight})
}
func (w *World) drop(p *Player) {
	count := len(w.Items)
	if count >= gameconfig.PickupsMaxItems {
		return
	}
	// Freeze probability per death; enforce remaining capacity per item.
	probability := 1.0
	if count > gameconfig.PickupsGuaranteedDropItems {
		probability = float64(gameconfig.PickupsMaxItems-count) / float64(gameconfig.PickupsMaxItems-gameconfig.PickupsGuaranteedDropItems)
	}
	e := p.State.Equipment
	for i := 0; i < 2+e.Grenades; i++ {
		if len(w.Items) >= gameconfig.PickupsMaxItems {
			break
		}
		if probability < 1 && core.NextRandom(&w.seed) >= probability {
			continue
		}
		kind := "grenade"
		switch i {
		case 0:
			kind = "health"
		case 1:
			kind = "weapon"
		}
		tilt := (core.NextRandom(&w.seed)*2 - 1) * gameconfig.PickupsDropTiltDegrees * math.Pi / 180
		azimuth := core.NextRandom(&w.seed) * math.Pi * 2
		v := core.Vec3{X: math.Sin(tilt)*math.Sin(azimuth)*gameconfig.PickupsDropSpeed + p.State.VX*gameconfig.PickupsInheritedVelocity, Y: -math.Sin(tilt)*math.Cos(azimuth)*gameconfig.PickupsDropSpeed + p.State.VY*gameconfig.PickupsInheritedVelocity, Z: math.Cos(tilt) * gameconfig.PickupsDropSpeed}
		v.X = math.Trunc(v.X*gameconfig.FlightVelocityQuantization) / gameconfig.FlightVelocityQuantization
		v.Y = math.Trunc(v.Y*gameconfig.FlightVelocityQuantization) / gameconfig.FlightVelocityQuantization
		v.Z = math.Trunc(v.Z*gameconfig.FlightVelocityQuantization) / gameconfig.FlightVelocityQuantization
		w.addItem(kind, e.Primary, core.Flight{Position: core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}, Velocity: v})
	}
}
func (w *World) pickup(p *Player, id int) {
	if id == 0 {
		return
	}
	for i, item := range w.Items {
		if item.ID != id || item.Kind != "weapon" || item.Expires <= w.Tick || math.Hypot(p.State.X-item.Position.X, p.State.Y-item.Position.Y) > gameconfig.PickupsRadius {
			continue
		}
		old := p.State.Equipment.Primary
		p.State.Equipment.Primary = item.Primary
		p.State.Equipment.Shells = 0
		p.State.Equipment.Heat = 1
		p.State.Equipment.Overheated = false
		p.State.Equipment.Charge = 0
		p.State.Equipment.FireTime = 0
		p.State.Equipment.SinceShot = 1
		p.State.Equipment.ScopeHeight = 7
		p.State.Equipment.Barrel = 0
		p.State.Cooldown = core.EquipDelaySeconds
		p.State.Spread = core.PrimaryRules(item.Primary).MinSpread
		flight := item.Flight
		w.Items = append(w.Items[:i], w.Items[i+1:]...)
		// A new identity prevents a second request for the consumed item from taking the replacement.
		w.addItem("weapon", old, flight)
		w.signal("pickup-equipment", p.ID, item.Position)
		return
	}
}
func (w *World) projectile(kind string, owner int, flight core.Flight) *Projectile {
	w.entityID++
	lifetime := durationTicks(gameconfig.MolotovFlightSeconds)
	if kind == "flame" {
		lifetime = durationTicks(gameconfig.MolotovFlameSeconds)
	}
	if kind == "grenade" {
		lifetime = durationTicks(gameconfig.GrenadeFuseSeconds)
	}
	p := &Projectile{ID: w.entityID, Kind: kind, Owner: owner, Born: w.Tick, Expires: w.Tick + lifetime, Flight: flight, nextDamage: w.Tick + durationTicks(gameconfig.MolotovDamageIntervalSeconds)}
	if kind == "minibot" {
		p.Turret = &TurretPresentation{}
	}
	if owner := w.Find(owner); owner != nil {
		p.ownerLife = owner.Life
	}
	w.Projectiles = append(w.Projectiles, p)
	return p
}
func (w *World) actions(p *Player, input core.Input, angle float64) {
	e := p.State.Equipment
	w.deploy(p, math.Atan2(input.Aim.Y-p.State.Y, input.Aim.X-p.State.X))
	if e.SecondaryActivated && e.Secondary == "shield" {
		p.body.Shield = true
		w.signal("shield", p.ID, core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius})
	}
	if e.SecondaryActivated && e.Secondary == "knives" {
		position := core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}
		hit := w.damageArea(p.ID, position, gameconfig.KnivesRadius, gameconfig.KnivesDamage, true, true, "knives")
		w.combatEffect("knives", p.ID, position, gameconfig.KnivesRadius, hit, p.Life)
	}
	if e.Action == "grenade" || e.Action == "molotov" {
		speed, z := gameconfig.GrenadeHorizontalSpeed, gameconfig.GrenadeVerticalSpeed
		if e.Action == "molotov" {
			speed = gameconfig.MolotovHorizontalSpeed
			z = gameconfig.MolotovVerticalSpeed
		}
		fx, fy := math.Cos(angle), math.Sin(angle)
		muzzle := core.Vec3{X: p.State.X + fy*gameconfig.ThrowingMuzzleRight, Y: p.State.Y - fx*gameconfig.ThrowingMuzzleRight, Z: gameconfig.ThrowingMuzzleHeight}
		position, normal := core.MapImpact(core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}, muzzle, w.Geometry.Walls, Geometry.WallHeight)
		if normal != nil {
			position.X += normal.X * gameconfig.FlightSurfaceClearance
			position.Y += normal.Y * gameconfig.FlightSurfaceClearance
			position.Z += normal.Z * gameconfig.FlightSurfaceClearance
		}
		w.projectile(e.Action, p.ID, core.Flight{Position: position, Velocity: core.Vec3{X: fx * speed, Y: fy * speed, Z: z}})
		w.signal("throw", p.ID, position)
	}
	if p.Status == "alive" {
		w.pickup(p, input.Pickup)
	}
}
func (w *World) updateEntities() {
	for _, p := range w.Players {
		p.body.X = p.State.X
		p.body.Y = p.State.Y
	}
	kept := w.Items[:0]
	for _, item := range w.Items {
		if item.Expires <= w.Tick {
			continue
		}
		speedSquared := item.Velocity.X*item.Velocity.X + item.Velocity.Y*item.Velocity.Y + item.Velocity.Z*item.Velocity.Z
		if normal := core.StepFlight(&item.Flight, gameconfig.TickSeconds, w.Geometry.Walls, Geometry.WallHeight, true); normal != nil && speedSquared > itemContactCueMinSpeed*itemContactCueMinSpeed {
			w.cue(Cue{Kind: "item-impact", Position: item.Position})
		}
		taken := false
		if item.Kind != "weapon" {
			for _, p := range w.Players {
				if p.Status != "alive" || math.Hypot(p.State.X-item.Position.X, p.State.Y-item.Position.Y) > gameconfig.PickupsRadius {
					continue
				}
				if item.Kind == "health" {
					p.HP = math.Min(gameconfig.PlayerMaxHealth, p.HP+gameconfig.PickupsHealthRestore)
					p.body.HP = p.HP
					w.signal("pickup-health", p.ID, item.Position)
				} else {
					p.State.Equipment.Grenades = min(gameconfig.GrenadeMaxCarry, p.State.Equipment.Grenades+1)
					w.signal("pickup-grenade", p.ID, item.Position)
				}
				taken = true
				break
			}
		}
		if !taken {
			kept = append(kept, item)
		}
	}
	w.Items = kept
	// New flames are appended during this pass and start moving on the next tick.
	count := len(w.Projectiles)
	for i := 0; i < count; i++ {
		p := w.Projectiles[i]
		if w.Find(p.Owner) == nil {
			p.Expires = w.Tick
			continue
		}
		if w.arsenalEntity(p) {
			continue
		}
		if p.Kind == "flame" {
			w.flame(p)
			continue
		}
		normal := core.StepFlight(&p.Flight, gameconfig.TickSeconds, w.Geometry.Walls, Geometry.WallHeight, p.Kind == "grenade")
		if normal != nil && p.Kind == "grenade" && p.Expires > w.Tick {
			w.signal("bounce", p.Owner, p.Position)
		}
		if p.Kind == "grenade" && p.Expires <= w.Tick {
			hit := w.damageArea(p.Owner, p.Position, gameconfig.GrenadeRadius, gameconfig.GrenadeDamage, false, false, "grenade")
			w.combatEffect("explosion", p.Owner, p.Position, gameconfig.GrenadeVisualRadius, hit, p.ownerLife)
		}
		if p.Kind != "molotov" || p.Expires <= w.Tick {
			continue
		}
		hitPlayer := false
		for _, player := range w.Players {
			if player.ID != p.Owner && player.Status == "alive" && w.canDamage(p.Owner, player) && math.Sqrt(((player.State.X-p.Position.X)*(player.State.X-p.Position.X))+((player.State.Y-p.Position.Y)*(player.State.Y-p.Position.Y))+((core.Radius-p.Position.Z)*(core.Radius-p.Position.Z))) <= gameconfig.MolotovHitRadius {
				hitPlayer = true
				break
			}
		}
		if normal != nil || hitPlayer {
			p.Expires = w.Tick
			w.signal("molotov-break", p.Owner, p.Position)
			if normal != nil {
				p.Position.X += normal.X * gameconfig.MolotovImpactClearance
				p.Position.Y += normal.Y * gameconfig.MolotovImpactClearance
				p.Position.Z += normal.Z * gameconfig.MolotovImpactClearance
			}
			w.projectile("flame", p.Owner, core.Flight{Position: p.Position})
			velocity := core.Vec3{}
			if !hitPlayer && normal != nil {
				v := p.Velocity
				dot := v.X*normal.X + v.Y*normal.Y + v.Z*normal.Z
				velocity = core.Vec3{X: (v.X-2*dot*normal.X)*gameconfig.MolotovReflectionScale + (core.NextRandom(&w.seed)*2-1)*gameconfig.MolotovScatterHorizontal, Y: (v.Y-2*dot*normal.Y)*gameconfig.MolotovReflectionScale + (core.NextRandom(&w.seed)*2-1)*gameconfig.MolotovScatterHorizontal, Z: (v.Z-2*dot*normal.Z)*gameconfig.MolotovReflectionScale + core.NextRandom(&w.seed)*gameconfig.MolotovScatterVertical}
				velocity.X = math.Trunc(velocity.X*gameconfig.FlightVelocityQuantization) / gameconfig.FlightVelocityQuantization
				velocity.Y = math.Trunc(velocity.Y*gameconfig.FlightVelocityQuantization) / gameconfig.FlightVelocityQuantization
				velocity.Z = math.Trunc(velocity.Z*gameconfig.FlightVelocityQuantization) / gameconfig.FlightVelocityQuantization
			}
			w.projectile("flame", p.Owner, core.Flight{Position: p.Position, Velocity: velocity})
		}
	}
	live := w.Projectiles[:0]
	for _, p := range w.Projectiles {
		if p.Expires > w.Tick {
			live = append(live, p)
		} else if p.Kind == "minibot" {
			w.signal("minibot-end", p.Owner, p.Position)
		} else if p.Kind == "flame" {
			w.signal("fire-end", p.Owner, p.Position)
		}
	}
	w.Projectiles = live
}
func (w *World) flame(f *Projectile) {
	if f.Expires <= w.Tick {
		return
	}
	if f.Attached != 0 {
		p := w.Find(f.Attached)
		if p == nil || p.Status != "alive" || w.Tick >= f.stickUntil {
			f.Attached = 0
			f.stickUntil = w.Tick + durationTicks(gameconfig.MolotovReattachDelaySeconds)
			f.locked = false
		} else {
			f.Position = core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}
		}
	}
	if f.Attached == 0 && w.Tick >= f.stickUntil {
		for _, p := range w.Players {
			if p.Status != "alive" || !w.canDamage(f.Owner, p) || p.ID == f.Owner && w.Tick-f.Born <= durationTicks(gameconfig.MolotovOwnerGraceSeconds) {
				continue
			}
			if math.Sqrt(((p.State.X-f.Position.X)*(p.State.X-f.Position.X))+((p.State.Y-f.Position.Y)*(p.State.Y-f.Position.Y))+((core.Radius-f.Position.Z)*(core.Radius-f.Position.Z))) <= gameconfig.MolotovAttachRadius {
				f.Attached = p.ID
				f.stickUntil = w.Tick + durationTicks(gameconfig.MolotovAttachSeconds)
				f.locked = true
				break
			}
		}
	}
	if !f.locked {
		if normal := core.StepFlight(&f.Flight, gameconfig.TickSeconds, w.Geometry.Walls, Geometry.WallHeight, false); normal != nil {
			f.locked = true
			f.Position.X += normal.X * gameconfig.MolotovImpactClearance
			f.Position.Y += normal.Y * gameconfig.MolotovImpactClearance
			f.Position.Z += normal.Z * gameconfig.MolotovImpactClearance
		}
	}
	// Original dedicated server: 20 updates at 30 Hz. Preserve elapsed time at 120 Hz.
	if w.Tick >= f.nextDamage {
		f.nextDamage += durationTicks(gameconfig.MolotovDamageIntervalSeconds)
		w.damageArea(f.Owner, f.Position, gameconfig.MolotovDamageRadius, gameconfig.MolotovDamage, false, false, "molotov")
	}
}

// A presentation cue never owns the accepted hit result.
func (w *World) combatEffect(kind string, owner int, position core.Vec3, radius float64, hit bool, life int) {
	id := w.cue(Cue{Kind: kind, Owner: owner, Life: life, Position: position, Radius: radius})
	if hit {
		w.event(Event{Kind: "hit", Owner: owner, Life: life, Action: id})
	}
}
