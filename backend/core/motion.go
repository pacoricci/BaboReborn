package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

// Motion is a post-step checkpoint. Birth is a separate lifecycle timestamp.
type Motion struct {
	Mode string `json:"motion"`
	Tick int    `json:"motionTick"`
	Flight
}

// Preserve the authority's cap-before-movement and acceleration-after-movement.
func StepRocket(f *Flight, dt float64) {
	speed := math.Hypot(f.Velocity.X, f.Velocity.Y)
	if speed > gameconfig.BazookaMaxSpeed {
		f.Velocity.X *= gameconfig.BazookaMaxSpeed / speed
		f.Velocity.Y *= gameconfig.BazookaMaxSpeed / speed
	}
	f.Position.X += f.Velocity.X * dt
	f.Position.Y += f.Velocity.Y * dt
	f.Velocity.X *= 1 + dt*gameconfig.BazookaAcceleration
	f.Velocity.Y *= 1 + dt*gameconfig.BazookaAcceleration
}
