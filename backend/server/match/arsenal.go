package match

import (
	"math"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
)

// Entity lifecycle and damage are authority-owned; core only requests actions.
func (w *World) primaryShot(p *Player, shot *core.Shot) {
	if shot == nil {
		return
	}
	if shot.Kind == "bazooka" {
		fx, fy := math.Cos(p.State.Angle), math.Sin(p.State.Angle)
		// The shot direction was sampled before the player's aim update.
		dx, dy := shot.To.X-shot.From.X, shot.To.Y-shot.From.Y
		if length := math.Hypot(dx, dy); length > 1e-9 {
			fx, fy = dx/length, dy/length
		}
		rocket := w.projectile("rocket", p.ID, core.Flight{Position: shot.From, Velocity: core.Vec3{X: fx * gameconfig.BazookaSpeed, Y: fy * gameconfig.BazookaSpeed}})
		rocket.Expires = w.Tick + durationTicks(gameconfig.BazookaLifetimeSeconds)
		w.emitShot(p.ID, shot)
		return
	}
	if shot.Kind == "photon" {
		beam := w.projectile("photon", p.ID, core.Flight{Position: shot.From})
		beam.end = shot.To
		beam.Expires = w.Tick + durationTicks(gameconfig.PhotonDurationSeconds)
		beam.nextDamage = w.Tick + durationTicks(gameconfig.PhotonPulseIntervalSeconds)
	}
	w.emitShot(p.ID, shot)
}
func (w *World) emitShot(owner int, shot *core.Shot) {
	id := w.cue(Cue{Kind: "shot", Owner: owner, Position: shot.From, Shot: shot})
	if shotHit(shot) {
		w.event(Event{Kind: "hit", Owner: owner, Action: id})
	}
}
func (w *World) deploy(p *Player, angle float64) {
	e := p.State.Equipment
	if !e.SecondaryActivated || e.Secondary != "minibot" {
		return
	}
	for _, entity := range w.Projectiles {
		if entity.Owner == p.ID && entity.Kind == "minibot" && entity.Expires > w.Tick {
			return
		}
	}
	from := core.Vec3{X: p.State.X, Y: p.State.Y, Z: core.Radius}
	position := core.Vec3{X: from.X + math.Cos(angle)*gameconfig.MinibotSpawnOffset, Y: from.Y + math.Sin(angle)*gameconfig.MinibotSpawnOffset, Z: gameconfig.MinibotHeight}
	if _, normal := core.MapImpact(from, position, w.Geometry.Walls, Geometry.WallHeight); normal != nil {
		return
	}
	entity := w.projectile(e.Secondary, p.ID, core.Flight{Position: position})
	if entity.Turret != nil {
		entity.Turret.Angle = angle
	}
	entity.Expires = w.Tick + durationTicks(gameconfig.MinibotLifetimeSeconds)
	entity.nextDamage = w.Tick
	w.signal("minibot-start", p.ID, position)
}
func (w *World) arsenalEntity(p *Projectile) bool {
	switch p.Kind {
	case "rocket":
		w.rocket(p)
	case "minibot":
		if owner := w.Find(p.Owner); owner == nil || owner.Status != "alive" {
			p.Expires = w.Tick
			return true
		}
		if p.Expires > w.Tick && w.Tick >= p.nextDamage {
			p.nextDamage = w.Tick + durationTicks(gameconfig.MinibotFireIntervalSeconds)
			w.turret(p)
		}
	case "photon":
		if w.Tick <= p.Expires && w.Tick >= p.nextDamage {
			p.nextDamage += durationTicks(gameconfig.PhotonPulseIntervalSeconds)
			for _, target := range w.Players {
				if target.ID == p.Owner || target.Status != "alive" || !w.canDamage(p.Owner, target) {
					continue
				}
				center := core.Vec3{X: target.State.X, Y: target.State.Y, Z: core.Radius}
				if core.SphereImpact(p.Position, p.end, center, gameconfig.PhotonPulseRadius) != nil {
					distance := math.Sqrt((center.X-p.Position.X)*(center.X-p.Position.X) + (center.Y-p.Position.Y)*(center.Y-p.Position.Y) + (center.Z-p.Position.Z)*(center.Z-p.Position.Z))
					core.ApplyDamage(&target.body, core.PhotonDamage(distance, gameconfig.PhotonDamage*gameconfig.PhotonPulseMultiplier))
				}
			}
			w.resolveDeaths(p.Owner, p.Kind)
		}
	default:
		return false
	}
	return true
}
func (w *World) explode(p *Projectile, radius, damage float64) {
	p.Expires = w.Tick
	hit := w.damageArea(p.Owner, p.Position, radius, damage, false, false, explosionWeapon(p.Kind))
	w.combatEffect("rocket-explosion", p.Owner, p.Position, radius, hit, p.ownerLife)
	if p.Kind == "rocket" {
		if owner := w.Find(p.Owner); owner != nil && owner.Life == p.ownerLife {
			owner.State.Equipment.RocketActive = false
		}
	}
}
func (w *World) rocket(p *Projectile) {
	owner := w.Find(p.Owner)
	if owner == nil {
		p.Expires = w.Tick
		return
	}
	if p.Expires <= w.Tick || (owner.Life == p.ownerLife && owner.State.Equipment.PrimaryAction == "detonate" && w.Tick-p.Born >= durationTicks(gameconfig.BazookaRemoteDelaySeconds)) {
		w.explode(p, gameconfig.BazookaRadius, gameconfig.BazookaDamage)
		return
	}
	from := p.Position
	core.StepRocket(&p.Flight, gameconfig.TickSeconds)
	end := p.Position
	to, normal := core.MapImpact(from, end, w.Geometry.Walls, Geometry.WallHeight)
	collision := normal != nil
	for _, target := range w.Players {
		if target.ID == p.Owner || target.Status != "alive" || !w.canDamage(p.Owner, target) {
			continue
		}
		if point := core.SphereImpact(from, to, core.Vec3{X: target.State.X, Y: target.State.Y, Z: core.Radius}, core.Radius); point != nil {
			to = *point
			collision = true
			normal = nil
		}
	}
	p.Position = to
	if collision {
		if normal != nil {
			p.Position.X += normal.X * gameconfig.FlightSurfaceClearance
			p.Position.Y += normal.Y * gameconfig.FlightSurfaceClearance
		}
		w.explode(p, gameconfig.BazookaRadius, gameconfig.BazookaDamage)
	}
}
func (w *World) turret(p *Projectile) {
	var victim *Player
	closest := gameconfig.MinibotRadius
	for _, target := range w.Players {
		if target.ID == p.Owner || target.Status != "alive" || !w.canDamage(p.Owner, target) {
			continue
		}
		distance := math.Hypot(target.State.X-p.Position.X, target.State.Y-p.Position.Y)
		if distance >= closest {
			continue
		}
		to := core.Vec3{X: target.State.X, Y: target.State.Y, Z: core.Radius}
		if _, normal := core.MapImpact(p.Position, to, w.Geometry.Walls, Geometry.WallHeight); normal != nil {
			continue
		}
		victim = target
		closest = distance
	}
	if victim == nil {
		return
	}
	p.Turret.Angle = math.Atan2(victim.State.Y-p.Position.Y, victim.State.X-p.Position.X)
	var bodies [MaxPlayers]*core.Body
	count := 0
	for _, target := range w.Players {
		if target.ID != p.Owner && target.Status == "alive" && w.canDamage(p.Owner, target) {
			bodies[count] = &target.body
			count++
		}
	}
	shot := core.TurretShot(p.Position, core.Vec3{X: victim.State.X, Y: victim.State.Y, Z: core.Radius}, w.Geometry.Walls, bodies[:count], &w.seed, Geometry.WallHeight)
	if shot != nil {
		p.Turret.LastShot = w.Tick
		w.emitShot(p.Owner, shot)
	}
	w.resolveDeaths(p.Owner, p.Kind)
}
