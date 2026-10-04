package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

type Equipment struct {
	Heat               float64 `json:"heat"` // [ratio]
	Overheated         bool    `json:"overheated"`
	Charge             float64 `json:"charge"`      // [s]
	FireTime           float64 `json:"fireTime"`    // [s]
	SinceShot          float64 `json:"sinceShot"`   // [s]
	ScopeHeight        float64 `json:"scopeHeight"` // [cells]
	RocketActive       bool    `json:"rocketActive"`
	RocketAge          float64 `json:"rocketAge"` // [s]
	PrimaryAction      string  `json:"primaryAction"`
	Barrel             int     `json:"barrel"`
	SecondaryActivated bool    `json:"secondaryActivated"`
	Primary            string  `json:"primary"`
	Secondary          string  `json:"secondary"`
	Grenades           int     `json:"grenades"`
	Molotovs           int     `json:"molotovs"`
	Shells             int     `json:"shells"`
	MeleeDelay         float64 `json:"meleeDelay"` // [s]
	ThrowDelay         float64 `json:"throwDelay"` // [s]
	Protection         float64 `json:"protection"` // [s]
	Action             string  `json:"action"`
}

func NewEquipment(primary, secondary string) Equipment {
	return Equipment{Heat: 1, SinceShot: 1, ScopeHeight: 7, Primary: primary, Secondary: secondary, Grenades: gameconfig.GrenadeSpawnCount, Molotovs: gameconfig.MolotovSpawnCount}
}
func updateEquipment(p *Player, dt float64) {
	e := &p.Equipment
	e.Action = ""
	e.PrimaryAction = ""
	e.SinceShot += dt
	if e.RocketActive {
		e.RocketAge += dt
	}
	e.SecondaryActivated = false
	e.MeleeDelay = math.Max(0, e.MeleeDelay-dt)
	e.ThrowDelay = math.Max(0, e.ThrowDelay-dt)
	e.Protection = math.Max(0, e.Protection-dt)
	if e.Shells == gameconfig.ShotgunShells && p.Cooldown <= 1e-9 {
		e.Shells = 0
	}
}
func canFire(p *Player) bool {
	return p.Equipment.MeleeDelay <= 1e-9 && p.Equipment.ThrowDelay <= 1e-9
}
func act(p *Player, input Input) {
	e := &p.Equipment
	if input.Secondary && canFire(p) {
		e.Action = e.Secondary
		e.SecondaryActivated = true
		e.MeleeDelay = gameconfig.KnivesCooldownSeconds
		if e.Secondary == "minibot" {
			e.MeleeDelay = gameconfig.MinibotCooldownSeconds
		}
		if e.Secondary == "shield" {
			e.MeleeDelay = gameconfig.ShieldCooldownSeconds
			e.Protection = gameconfig.ShieldProtectionSeconds
		}
	}
	if e.ThrowDelay > 1e-9 || p.Cooldown > 1e-9 {
		return
	}
	if input.Grenade && e.Grenades > 0 && e.MeleeDelay <= 1e-9 {
		e.Grenades--
		e.Action = "grenade"
	} else if input.Molotov && e.Molotovs > 0 {
		e.Molotovs--
		e.Action = "molotov"
	} else {
		return
	}
	e.ThrowDelay = gameconfig.ThrowingCooldownSeconds
	p.VX += math.Cos(p.Angle) * gameconfig.ThrowingImpulse
	p.VY += math.Sin(p.Angle) * gameconfig.ThrowingImpulse
}
func ApplyDamage(b *Body, damage float64) {
	if b.Immune {
		return
	}
	if b.Shield {
		damage *= gameconfig.ShieldDamageMultiplier
	}
	b.HP = math.Max(0, b.HP-damage)
}
