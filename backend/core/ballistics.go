package core

func MapImpact(from, to Vec3, walls []Wall, height float64) (Vec3, *Vec3) {
	fraction := 1.
	var normal *Vec3
	dx, dy, dz := to.X-from.X, to.Y-from.Y, to.Z-from.Z
	if from.Z > 0 && to.Z <= 0 {
		fraction = -from.Z / dz
		normal = &Vec3{Z: 1}
	}
	for _, w := range walls {
		wallHeight := height
		if w.Height > 0 {
			wallHeight = w.Height
		}
		if from.X >= w.X && from.X < w.X+w.W && from.Y >= w.Y && from.Y < w.Y+w.H && from.Z < wallHeight {
			return from, &Vec3{}
		}
		for face := 0; face < 5; face++ {
			var t float64
			if face == 0 {
				if from.Z <= wallHeight || to.Z > wallHeight {
					continue
				}
				t = (wallHeight - from.Z) / dz
			} else if face <= 2 {
				edge := w.X
				if face == 2 {
					edge += w.W
				}
				if face == 1 && !(from.X <= edge && to.X > edge) || face == 2 && !(from.X >= edge && to.X < edge) {
					continue
				}
				t = (edge - from.X) / dx
			} else {
				edge := w.Y
				if face == 4 {
					edge += w.H
				}
				if face == 3 && !(from.Y <= edge && to.Y > edge) || face == 4 && !(from.Y >= edge && to.Y < edge) {
					continue
				}
				t = (edge - from.Y) / dy
			}
			if t < 0 || t > fraction {
				continue
			}
			x, y, z := from.X+dx*t, from.Y+dy*t, from.Z+dz*t
			if x < w.X-1e-10 || x > w.X+w.W+1e-10 || y < w.Y-1e-10 || y > w.Y+w.H+1e-10 || face != 0 && z >= wallHeight {
				continue
			}
			fraction = t
			normal = &Vec3{}
			switch face {
			case 0:
				normal.Z = 1
			case 1:
				normal.X = -1
			case 2:
				normal.X = 1
			case 3:
				normal.Y = -1
			case 4:
				normal.Y = 1
			}
		}
	}
	return Vec3{from.X + dx*fraction, from.Y + dy*fraction, from.Z + dz*fraction}, normal
}
func SphereImpact(from, to, center Vec3, radius float64) *Vec3 {
	dx, dy, dz := to.X-from.X, to.Y-from.Y, to.Z-from.Z
	length := dx*dx + dy*dy + dz*dz
	if length == 0 {
		return nil
	}
	t := Clamp(((center.X-from.X)*dx+(center.Y-from.Y)*dy+(center.Z-from.Z)*dz)/length, 0, 1)
	p := Vec3{from.X + dx*t, from.Y + dy*t, from.Z + dz*t}
	x, y, z := p.X-center.X, p.Y-center.Y, p.Z-center.Z
	if x*x+y*y+z*z <= radius*radius {
		return &p
	}
	return nil
}
