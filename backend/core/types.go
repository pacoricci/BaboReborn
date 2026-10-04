// Package core contains render-free mechanics. Callers own time, geometry and lifecycle.
package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

type Vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Vec3 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}
type Wall struct {
	Height float64 `json:"height,omitempty"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	W      float64 `json:"w"`
	H      float64 `json:"h"`
}
type Player struct {
	Equipment Equipment `json:"equipment"`
	X         float64   `json:"x"`
	Y         float64   `json:"y"`
	VX        float64   `json:"vx"`
	VY        float64   `json:"vy"`
	Angle     float64   `json:"angle"`    // [radians]
	Cooldown  float64   `json:"cooldown"` // [s]
	Spread    float64   `json:"spread"`   // [degrees]
}
type Input struct {
	Secondary bool    `json:"secondary,omitempty"`
	Grenade   bool    `json:"grenade,omitempty"`
	Molotov   bool    `json:"molotov,omitempty"`
	Pickup    int     `json:"pickup,omitempty"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	Aim       Vec2    `json:"aim"`
	Fire      bool    `json:"fire"`
}
type Body struct {
	ID               int
	X, Y, Radius, HP float64
	Immune           bool
	Shield           bool
}
type Shot struct {
	Surface  bool    `json:"surface,omitempty"`
	Kind     string  `json:"kind,omitempty"`
	Pellets  []*Shot `json:"pellets,omitempty"`
	From     Vec3    `json:"from"`
	To       Vec3    `json:"to"`
	Hit      bool    `json:"hit"`
	Killed   bool    `json:"killed"`
	TargetID *int    `json:"targetId"`
}
type ShotGeometry struct {
	MuzzleOffset float64 `json:"muzzleOffset"`
	MuzzleSide   float64 `json:"muzzleSide"`
	MuzzleHeight float64 `json:"muzzleHeight"`
	MaxDistance  float64 `json:"maxDistance"`
	WallHeight   float64 `json:"wallHeight"`
}
type World struct {
	Walls []Wall
	Grid  Grid
}

// Short names retained for existing core consumers; values live in backend/gameconfig/rules.go.
const (
	Acceleration                   = gameconfig.MovementAcceleration
	Friction                       = gameconfig.MovementFriction
	MaxSpeed                       = gameconfig.MovementMaxSpeed
	Radius                         = gameconfig.MovementRadius
	Bounce                         = gameconfig.MovementBounce
	Clearance                      = gameconfig.MovementClearance
	Recoil                         = gameconfig.SmgRecoil
	FireIntervalSeconds            = gameconfig.SmgFireIntervalSeconds
	EquipDelaySeconds              = gameconfig.SmgEquipDelaySeconds
	Damage                         = gameconfig.SmgDamage
	MinSpreadDegrees               = gameconfig.SmgMinSpreadDegrees
	MaxSpreadDegrees               = gameconfig.SmgMaxSpreadDegrees
	SpreadPerShotDegrees           = gameconfig.SmgSpreadPerShotDegrees
	SpreadRecoveryDegreesPerSecond = gameconfig.SmgSpreadRecoveryDegreesPerSecond
)

func Clamp(n, low, high float64) float64 { return math.Max(low, math.Min(high, n)) }
func NewPlayer(v Vec2, angle float64) Player {
	return Player{Equipment: NewEquipment("smg", "knives"), X: v.X, Y: v.Y, Angle: angle, Cooldown: EquipDelaySeconds, Spread: MinSpreadDegrees}
}
func NextRandom(seed *uint32) float64 {
	*seed = *seed*1664525 + 1013904223
	return float64(*seed) / 4294967296
}
