package match

import "baboreborn/backend/gameconfig"

// Snapshot capture runs at gameconfig.TickHz / SnapshotEvery. Delivery pacing
// belongs to replication/timing.go.
const SnapshotEvery = 4

// Input silence thresholds, measured in authority ticks.
const (
	inputTimeoutTicks = 30
	disconnectTicks   = 600
)

// Bound trajectory reconstruction to one second of authority steps.
const MotionAnchorTicks = gameconfig.TickHz
