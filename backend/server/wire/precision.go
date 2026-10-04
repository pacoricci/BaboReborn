package wire

import (
	"fmt"
	"math"
)

const (
	// Wire units only: authority and the local checkpoint stay binary64.
	positionUnitsPerWorldUnit = 4096
	angleStepsPerTurn         = 65536
)

func (e *protoEncoder) position(v float64) int32 {
	q := math.Round(e.number(v) * positionUnitsPerWorldUnit)
	if e.err != nil || q < math.MinInt32 || q > math.MaxInt32 {
		e.err = fmt.Errorf("snapshot position outside quantized range")
		return 0
	}
	return int32(q)
}

func (e *protoEncoder) angle(v float64) uint32 {
	v = math.Mod(e.number(v), 2*math.Pi)
	if e.err != nil {
		return 0
	}
	if v < 0 {
		v += 2 * math.Pi
	}
	return uint32(math.Round(v*angleStepsPerTurn/(2*math.Pi))) % angleStepsPerTurn
}
