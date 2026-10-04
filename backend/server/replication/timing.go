package replication

import "time"

// State delivery timing. The room owner supplies the base cadence via Pace;
// authority tick and capture frequencies live in match/timing.go.
const (
	standingsInterval = 250 * time.Millisecond
	statePacingSlack  = time.Millisecond
)

// Congestion thresholds are excess delay above the peer's best receipt RTT.
const (
	congestionSlowDelay  = 250 * time.Millisecond
	congestionStallDelay = 500 * time.Millisecond
	congestionSlowHz     = 20
	congestionStallHz    = 10
	recoveryInterval     = time.Second
	recoveryStepHz       = 10
)
