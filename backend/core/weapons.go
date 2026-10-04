// Portions adapted from BaboViolent 2, src/Game/Weapon.cpp.
// Copyright 2012 bitHeads inc.
// SPDX-License-Identifier: GPL-3.0-or-later
// Adapted for BaboReborn; see CREDITS.md and
// frontend/public/licenses/BaboViolent2.txt for provenance and the original notice.

package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

func IsPrimary(value string) bool {
	switch value {
	case "smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower":
		return true
	}
	return false
}
func IsSecondary(value string) bool {
	switch value {
	case "knives", "shield", "minibot":
		return true
	}
	return false
}

type PrimaryRule struct{ Interval, Damage, Recoil, MinSpread, MaxSpread float64 }

func PrimaryRules(primary string) PrimaryRule {
	switch primary {
	case "dual":
		return PrimaryRule{gameconfig.DualFireIntervalSeconds, gameconfig.DualDamage, gameconfig.DualRecoil, gameconfig.DualMinSpreadDegrees, gameconfig.DualMaxSpreadDegrees}
	case "chain":
		return PrimaryRule{gameconfig.ChainFireIntervalSeconds, gameconfig.ChainDamage, gameconfig.ChainRecoil, gameconfig.ChainMinSpreadDegrees, gameconfig.ChainMaxSpreadDegrees}
	case "shotgun":
		return PrimaryRule{gameconfig.ShotgunFireIntervalSeconds, gameconfig.ShotgunDamage, gameconfig.ShotgunRecoil, 0, 0}
	case "sniper":
		return PrimaryRule{gameconfig.SniperFireIntervalSeconds, gameconfig.SniperDamage, gameconfig.SniperRecoil, 0, 0}
	case "bazooka":
		return PrimaryRule{gameconfig.BazookaFireIntervalSeconds, gameconfig.BazookaDamage, gameconfig.BazookaRecoil, 0, 0}
	case "photon":
		return PrimaryRule{gameconfig.PhotonFireIntervalSeconds, gameconfig.PhotonDamage, gameconfig.PhotonRecoil, 0, 0}
	case "flamethrower":
		return PrimaryRule{gameconfig.FlamethrowerFireIntervalSeconds, gameconfig.FlamethrowerDamage, gameconfig.FlamethrowerRecoil, gameconfig.FlamethrowerSpreadDegrees, gameconfig.FlamethrowerSpreadDegrees}
	default:
		return PrimaryRule{FireIntervalSeconds, Damage, Recoil, MinSpreadDegrees, MaxSpreadDegrees}
	}
}
func primaryReady(p *Player, input Input, dt float64) bool {
	e := &p.Equipment
	if !input.Fire {
		return false
	}
	if e.Primary == "bazooka" && e.RocketActive {
		if e.RocketAge >= gameconfig.BazookaRemoteDelaySeconds-1e-9 {
			e.PrimaryAction = "detonate"
		}
		return false
	}
	if p.Cooldown > 1e-9 || !canFire(p) || e.Overheated {
		return false
	}
	if e.Primary == "photon" && e.Charge < gameconfig.PhotonChargeSeconds-1e-9 {
		e.Charge += dt
		return false
	}
	if e.Primary == "flamethrower" {
		if e.SinceShot < gameconfig.FlamethrowerResetGapSeconds {
			e.FireTime += gameconfig.FlamethrowerFireIntervalSeconds
		} else {
			e.FireTime = 0
		}
	}
	return true
}
func finishPrimary(p *Player) {
	e := &p.Equipment
	r := PrimaryRules(e.Primary)
	p.VX -= math.Cos(p.Angle) * r.Recoil
	p.VY -= math.Sin(p.Angle) * r.Recoil
	p.Cooldown += r.Interval
	e.Charge = 0
	e.SinceShot = 0
	if e.Primary == "dual" {
		e.Barrel = 1 - e.Barrel
	}
	if e.Primary == "chain" {
		e.Barrel = (e.Barrel + 1) % 4
	}
	if e.Primary == "chain" {
		e.Heat -= gameconfig.ChainHeatPerShot
		if e.Heat < 0 {
			e.Heat = 0
			e.Overheated = true
		}
	}
	if e.Primary == "bazooka" {
		e.RocketActive = true
		e.RocketAge = 0
		e.PrimaryAction = "rocket"
	}
}
func updatePrimary(p *Player, input Input, dt float64) {
	e := &p.Equipment
	if e.Primary == "chain" {
		e.Heat = math.Min(1, e.Heat+gameconfig.ChainRecovery*dt)
		if e.Heat > gameconfig.ChainResumeAbove {
			e.Overheated = false
		}
	}
	if e.Primary == "sniper" {
		height := Clamp(math.Sqrt((input.Aim.X-p.X)*(input.Aim.X-p.X)+(input.Aim.Y-p.Y)*(input.Aim.Y-p.Y)+Radius*Radius)*gameconfig.SniperAimScale, gameconfig.SniperMinHeight, gameconfig.SniperMaxHeight)
		e.ScopeHeight += (height - e.ScopeHeight) * math.Min(1, gameconfig.SniperFollow*dt)
	}
}
func PhotonDamage(distance, damage float64) float64 {
	return damage * (gameconfig.PhotonVerticalShift + gameconfig.PhotonCoefficient*(math.Pi/2-math.Atan((distance-gameconfig.PhotonHorizontalShift)*gameconfig.PhotonDistanceMultiplier)))
}

func WeaponGeometry(primary string, barrel int, g ShotGeometry) ShotGeometry {
	switch primary {
	case "dual":
		if barrel == 0 {
			g.MuzzleSide = gameconfig.DualMuzzleRight2
			g.MuzzleOffset = gameconfig.DualMuzzleForward2
			g.MuzzleHeight = gameconfig.DualMuzzleHeight2
		} else {
			g.MuzzleSide = gameconfig.DualMuzzleRight
			g.MuzzleOffset = gameconfig.DualMuzzleForward
			g.MuzzleHeight = gameconfig.DualMuzzleHeight
		}
	case "chain":
		index := (barrel + 1) % 4
		g.MuzzleSide = gameconfig.ChainMuzzleRight
		g.MuzzleOffset = gameconfig.ChainMuzzleForward
		g.MuzzleHeight = gameconfig.ChainMuzzleHeight
		if index == 2 {
			g.MuzzleSide -= .1
		} else if index != 0 {
			g.MuzzleSide -= .05
		}
		switch index {
		case 1:
			g.MuzzleHeight -= .05
		case 3:
			g.MuzzleHeight += .05
		}
	case "sniper":
		g.MuzzleSide = gameconfig.SniperMuzzleRight
		g.MuzzleOffset = gameconfig.SniperMuzzleForward
		g.MuzzleHeight = gameconfig.SniperMuzzleHeight
	case "bazooka":
		g.MuzzleSide = gameconfig.BazookaMuzzleRight
		g.MuzzleOffset = gameconfig.BazookaMuzzleForward
		g.MuzzleHeight = gameconfig.BazookaMuzzleHeight
	case "photon":
		g.MuzzleSide = gameconfig.PhotonMuzzleRight
		g.MuzzleOffset = gameconfig.PhotonMuzzleForward
		g.MuzzleHeight = gameconfig.PhotonMuzzleHeight
	case "flamethrower":
		g.MuzzleSide = gameconfig.FlamethrowerMuzzleRight
		g.MuzzleOffset = gameconfig.FlamethrowerMuzzleForward
		g.MuzzleHeight = gameconfig.FlamethrowerMuzzleHeight
	}
	return g
}
