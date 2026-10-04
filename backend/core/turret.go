package core

import (
	"math"

	"baboreborn/backend/gameconfig"
)

// A stationary autonomous shot uses the same seeded angular dispersion and cover queries.
func TurretShot(position, target Vec3, walls []Wall, bodies []*Body, seed *uint32, wallHeight float64) *Shot {
	dx, dy, dz := target.X-position.X, target.Y-position.Y, target.Z-position.Z
	length := math.Sqrt(dx*dx + dy*dy + dz*dz)
	if length <= 1e-9 {
		return nil
	}
	dx /= length
	dy /= length
	dz /= length
	planar := math.Hypot(dx, dy)
	if planar <= 1e-9 {
		return nil
	}
	from := Vec3{position.X + dy/planar*gameconfig.MinibotMuzzleRight, position.Y - dx/planar*gameconfig.MinibotMuzzleRight, position.Z}
	deviation := (NextRandom(seed)*2 - 1) * gameconfig.MinibotSpreadDegrees * math.Pi / 180
	roll := NextRandom(seed) * math.Pi * 2
	lateral, vertical := math.Sin(deviation)*math.Cos(roll), math.Sin(deviation)*math.Sin(roll)
	x := dx*math.Cos(deviation) - dy/planar*lateral - dx*dz/planar*vertical
	y := dy*math.Cos(deviation) + dx/planar*lateral - dy*dz/planar*vertical
	z := (dz*math.Cos(deviation) + planar*vertical) * gameconfig.SmgVerticalSpreadScale
	end := Vec3{from.X + x*gameconfig.MinibotShotRange, from.Y + y*gameconfig.MinibotShotRange, from.Z + z*gameconfig.MinibotShotRange}
	to, normal := MapImpact(from, end, walls, wallHeight)
	var victim *Body
	for _, body := range bodies {
		if body.HP <= 0 {
			continue
		}
		if point := SphereImpact(from, to, Vec3{body.X, body.Y, body.Radius}, body.Radius); point != nil {
			victim = body
			to = *point
		}
	}
	shot := &Shot{Kind: "minibot", From: from, To: to, Surface: normal != nil && victim == nil}
	if victim != nil {
		ApplyDamage(victim, gameconfig.MinibotDamage)
		id := victim.ID
		shot.TargetID = &id
		shot.Hit = true
		shot.Killed = victim.HP == 0
	}
	return shot
}
