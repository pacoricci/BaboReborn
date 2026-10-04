package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

// Flight is independent of ownership, damage, pickups and match rules.
type Flight struct {
	Position Vec3 `json:"position"`
	Velocity Vec3 `json:"velocity"`
}

func StepFlight(f *Flight, dt float64, walls []Wall, height float64, bounce bool) *Vec3 {
	v := &f.Velocity
	if bounce && math.Sqrt(v.X*v.X+v.Y*v.Y+v.Z*v.Z) <= gameconfig.FlightRestSpeed && f.Position.Z <= gameconfig.FlightRestHeight {
		*v = Vec3{}
		return nil
	}
	end := Vec3{f.Position.X + v.X*dt, f.Position.Y + v.Y*dt, f.Position.Z + v.Z*dt}
	v.Z -= gameconfig.FlightGravity * dt
	point, normal := MapImpact(f.Position, end, walls, height)
	f.Position = point
	if normal != nil && bounce {
		f.Position.X += normal.X * gameconfig.FlightSurfaceClearance
		f.Position.Y += normal.Y * gameconfig.FlightSurfaceClearance
		f.Position.Z += normal.Z * gameconfig.FlightSurfaceClearance
		dot := v.X*normal.X + v.Y*normal.Y + v.Z*normal.Z
		v.X = (v.X - 2*dot*normal.X) * gameconfig.FlightBounceRetention
		v.Y = (v.Y - 2*dot*normal.Y) * gameconfig.FlightBounceRetention
		v.Z = (v.Z - 2*dot*normal.Z) * gameconfig.FlightBounceRetention
	}
	return normal
}
func AreaDamage(position Vec3, radius, damage float64, uniform bool, body *Body, walls []Wall, height float64) float64 {
	target := Vec3{body.X, body.Y, body.Radius}
	distance := math.Sqrt(((position.X - target.X) * (position.X - target.X)) + ((position.Y - target.Y) * (position.Y - target.Y)) + ((position.Z - target.Z) * (position.Z - target.Z)))
	if distance >= radius {
		return 0
	}
	if _, normal := MapImpact(position, target, walls, height); normal != nil {
		return 0
	}
	if uniform {
		return damage
	}
	return damage * (1 - distance/radius)
}
