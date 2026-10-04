package match

import "baboreborn/backend/core"

func stationary(f core.Flight) bool { return f.Velocity == (core.Vec3{}) }
func (w *World) itemMode(i *Item) string {
	if w.Match.Phase != "playing" || stationary(i.Flight) {
		return "fixed"
	}
	return "bounce"
}
func (w *World) projectileMode(p *Projectile) string {
	if w.Match.Phase != "playing" {
		return "fixed"
	}
	switch p.Kind {
	case "grenade":
		if stationary(p.Flight) {
			return "fixed"
		}
		return "bounce"
	case "molotov":
		return "fall"
	case "rocket":
		return "rocket"
	case "flame":
		if p.Attached != 0 {
			return "attached"
		}
		if p.locked {
			return "fixed"
		}
		return "fall"
	default:
		return "fixed"
	}
}
func anchor(old core.Motion, mode string, tick int, f core.Flight, transition bool) core.Motion {
	if mode == "fixed" {
		f.Velocity = core.Vec3{}
	}
	if mode == "attached" {
		f.Velocity = core.Vec3{}
	}
	if old.Mode == "" || old.Mode != mode || transition ||
		mode == "fixed" && old.Position != f.Position ||
		mode != "fixed" && mode != "attached" && tick-old.Tick >= MotionAnchorTicks {
		return core.Motion{Mode: mode, Tick: tick, Flight: f}
	}
	return old
}
func (w *World) anchorEntities() {
	for _, i := range w.Items {
		i.motion = anchor(i.motion, w.itemMode(i), w.Tick, i.Flight, false)
	}
	for _, p := range w.Projectiles {
		p.motion = anchor(p.motion, w.projectileMode(p), w.Tick, p.Flight, p.Attached != p.motionCarrier)
		p.motionCarrier = p.Attached
	}
}

// Capture also supports initial/test worlds before their first authority step,
// without modifying simulation state or a previously shared checkpoint.
func (w *World) ItemMotion(i *Item) core.Motion {
	return anchor(i.motion, w.itemMode(i), w.Tick, i.Flight, false)
}
func (w *World) ProjectileMotion(p *Projectile) core.Motion {
	return anchor(p.motion, w.projectileMode(p), w.Tick, p.Flight, p.Attached != p.motionCarrier)
}
