// Portions adapted from BaboViolent 2, src/Game/PlayerUpdate.cpp and Weapon.cpp.
// Copyright 2012 bitHeads inc.
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted for BaboReborn; see CREDITS.md and
// frontend/public/licenses/BaboViolent2.txt for provenance and the original notice.

package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

func fire(p *Player, walls []Wall, bodies []*Body, seed *uint32, g ShotGeometry, pellet int) *Shot {
	rule := PrimaryRules(p.Equipment.Primary)
	shotgun := p.Equipment.Primary == "shotgun" && pellet >= 0
	beam := p.Equipment.Primary == "photon" || p.Equipment.Primary == "flamethrower"
	angle := p.Angle
	if shotgun {
		angle += (float64(pellet) - float64(gameconfig.ShotgunPellets-1)/2) * gameconfig.ShotgunPelletAngleDegrees * math.Pi / 180
	}
	fx, fy := math.Cos(angle), math.Sin(angle)
	if pellet < 0 {
		p.Spread = math.Min(rule.MaxSpread, p.Spread+SpreadPerShotDegrees)
	}
	spread := p.Spread
	if rule.MaxSpread == 0 {
		spread = 0
	}
	if shotgun {
		spread = gameconfig.ShotgunSpreadDegrees
	}
	if p.Equipment.Primary == "chain" && math.Hypot(p.VX, p.VY) < gameconfig.ChainPrecisionSpeed {
		spread /= gameconfig.ChainPrecisionDivisor
	}
	deviation := (NextRandom(seed)*2 - 1) * spread * math.Pi / 180
	roll := NextRandom(seed) * math.Pi * 2
	lateral := math.Sin(deviation) * math.Cos(roll)
	dx, dy, dz := fx*math.Cos(deviation)-fy*lateral, fy*math.Cos(deviation)+fx*lateral, math.Sin(deviation)*math.Sin(roll)*gameconfig.SmgVerticalSpreadScale
	length := math.Sqrt(dx*dx + dy*dy + dz*dz)
	sinTheta := math.Hypot(dz, dx*math.Sin(p.Angle)-dy*math.Cos(p.Angle)) / length
	distance := g.MaxDistance
	if shotgun {
		distance = gameconfig.ShotgunRangeScale / math.Max(sinTheta, 1e-12) / length
	}
	if p.Equipment.Primary == "flamethrower" {
		distance = math.Max(gameconfig.FlamethrowerMinRange, (1-p.Equipment.FireTime/gameconfig.FlamethrowerExpirationSeconds)*gameconfig.FlamethrowerMaxRange)
	}
	muzzle := Vec3{p.X + math.Cos(p.Angle)*g.MuzzleOffset + math.Sin(p.Angle)*g.MuzzleSide, p.Y + math.Sin(p.Angle)*g.MuzzleOffset - math.Cos(p.Angle)*g.MuzzleSide, g.MuzzleHeight}
	endpoint := Vec3{muzzle.X + dx*distance, muzzle.Y + dy*distance, muzzle.Z + dz*distance}
	from, normal := MapImpact(Vec3{p.X, p.Y, Radius}, muzzle, walls, g.WallHeight)
	if normal != nil {
		from.X += normal.X * gameconfig.FlightSurfaceClearance
		from.Y += normal.Y * gameconfig.FlightSurfaceClearance
		from.Z += normal.Z * gameconfig.FlightSurfaceClearance
	}
	to, surfaceNormal := MapImpact(from, endpoint, walls, g.WallHeight)
	var victim *Body

	if p.Equipment.Primary == "bazooka" {
		bodies = nil
	}
	for _, body := range bodies {
		if body.HP <= 0 {
			continue
		}
		radius := body.Radius
		if p.Equipment.Primary == "flamethrower" {
			radius = gameconfig.FlamethrowerHitRadius
		}
		if point := SphereImpact(from, to, Vec3{body.X, body.Y, body.Radius}, radius); point != nil {
			if !beam {
				to = *point
			}
			victim = body
			if beam {
				d := math.Sqrt((body.X-from.X)*(body.X-from.X) + (body.Y-from.Y)*(body.Y-from.Y) + (body.Radius-from.Z)*(body.Radius-from.Z))
				damage := PhotonDamage(d, gameconfig.PhotonDamage)
				if p.Equipment.Primary == "flamethrower" {
					damage = gameconfig.FlamethrowerDamage * math.Max(0, 1-d/gameconfig.FlamethrowerMaxRange)
				}
				ApplyDamage(body, damage)
			}
		}
	}
	shot := &Shot{Kind: p.Equipment.Primary, From: from, To: to, Surface: surfaceNormal != nil && (victim == nil || beam)}
	if victim != nil {
		if !beam {
			ApplyDamage(victim, rule.Damage)
		}
		shot.Hit = true
		shot.Killed = victim.HP == 0
		id := victim.ID
		shot.TargetID = &id
	}
	return shot
}
func Step(p *Player, input Input, dt float64, world World, bodies []*Body, seed *uint32, g ShotGeometry) *Shot {
	p.Cooldown = math.Max(0, p.Cooldown-dt)
	p.Spread = math.Max(PrimaryRules(p.Equipment.Primary).MinSpread, p.Spread-SpreadRecoveryDegreesPerSecond*dt)
	updateEquipment(p, dt)
	if p.Equipment.Primary == "shotgun" {
		g.MuzzleOffset = gameconfig.ShotgunMuzzleForward
		g.MuzzleSide = gameconfig.ShotgunMuzzleRight
	}
	g = WeaponGeometry(p.Equipment.Primary, p.Equipment.Barrel, g)
	oldX, oldY := p.X, p.Y
	p.X += p.VX * dt
	p.Y += p.VY * dt
	speed := math.Hypot(p.VX, p.VY)
	remaining := math.Max(0, speed-Friction*dt)
	if speed > 0 {
		p.VX *= remaining / speed
		p.VY *= remaining / speed
	}
	p.VX += Clamp(input.X, -1, 1) * Acceleration * dt
	p.VY += Clamp(input.Y, -1, 1) * Acceleration * dt
	var shot *Shot
	if primaryReady(p, input, dt) {
		if p.Equipment.Primary == "shotgun" {
			pellets := make([]*Shot, gameconfig.ShotgunPellets)
			for i := range pellets {
				pellets[i] = fire(p, world.Walls, bodies, seed, g, i)
			}
			first := *pellets[0]
			shot = &first
			shot.Pellets = pellets
			p.VX -= math.Cos(p.Angle) * gameconfig.ShotgunRecoil
			p.VY -= math.Sin(p.Angle) * gameconfig.ShotgunRecoil
			p.Equipment.Shells++
			p.Cooldown = gameconfig.ShotgunFireIntervalSeconds
			if p.Equipment.Shells == gameconfig.ShotgunShells {
				p.Cooldown = gameconfig.ShotgunReloadSeconds
			}
		} else {
			if p.Equipment.Primary == "sniper" {
				count := gameconfig.SniperNormalRays
				if p.Equipment.ScopeHeight >= gameconfig.SniperScopeThreshold {
					count = gameconfig.SniperScopedRays
				}
				pellets := make([]*Shot, count)
				for i := range pellets {
					pellets[i] = fire(p, world.Walls, bodies, seed, g, i)
				}
				first := *pellets[0]
				shot = &first
				shot.Pellets = pellets
			} else {
				shot = fire(p, world.Walls, bodies, seed, g, -1)
			}
			finishPrimary(p)
		}
	}
	updatePrimary(p, input, dt)
	act(p, input)
	next := math.Hypot(p.VX, p.VY)
	if next > MaxSpeed {
		p.VX *= MaxSpeed / next
		p.VY *= MaxSpeed / next
	}
	close := math.Sqrt((input.Aim.X-p.X)*(input.Aim.X-p.X)+(input.Aim.Y-p.Y)*(input.Aim.Y-p.Y)+Radius*Radius) <= gameconfig.SmgCloseAimDistance
	ox, oy := p.X, p.Y
	if !close {
		ox += math.Cos(p.Angle)*g.MuzzleOffset + math.Sin(p.Angle)*g.MuzzleSide
		oy += math.Sin(p.Angle)*g.MuzzleOffset - math.Cos(p.Angle)*g.MuzzleSide
	}
	if math.Hypot(input.Aim.X-ox, input.Aim.Y-oy) > 1e-8 {
		p.Angle = math.Atan2(input.Aim.Y-oy, input.Aim.X-ox)
	}
	ResolveGrid(p, oldX, oldY, world.Grid)
	return shot
}
