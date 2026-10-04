package maps

import (
	"math"
)

// Decal is authored floor art. Dimensions use map cells; Angle uses radians.
type Decal struct {
	Asset   string  `json:"asset"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	W       float64 `json:"w"`
	H       float64 `json:"h"`
	Angle   float64 `json:"angle"`
	Opacity float64 `json:"opacity"`
}

func (d Decal) valid(width, height float64) bool {
	for _, v := range []float64{d.X, d.Y, d.W, d.H, d.Angle, d.Opacity} {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	if !identifier.MatchString(d.Asset) || d.W < MinDecalSize || d.W > MaxDecalSize || d.H < MinDecalSize || d.H > MaxDecalSize || d.Angle < -math.Pi || d.Angle > math.Pi || d.Opacity < 0 || d.Opacity > 1 {
		return false
	}
	// Bound the rotated footprint, not just its centre.
	c, s := math.Abs(math.Cos(d.Angle)), math.Abs(math.Sin(d.Angle))
	x, y := (c*d.W+s*d.H)/2, (s*d.W+c*d.H)/2
	return d.X >= x && d.X <= width-x && d.Y >= y && d.Y <= height-y
}
