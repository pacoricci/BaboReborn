package transport

import (
	"time"

	"baboreborn/backend/gameconfig"
)

const tickPeriod = time.Second / gameconfig.TickHz
const maxStepsPerWake = 8

type clockBatch struct {
	steps   int
	dropped int64
	elapsed time.Duration
	lag     time.Duration
}

type simulationClock struct {
	last      time.Time
	remainder time.Duration
}

// Notifications only wake the owner: their timestamps may predate a scheduler
// stall. Whole steps above the cap are discarded explicitly, never simulated
// with a larger dt or retained as an unbounded catch-up debt.
func (c *simulationClock) advance(now time.Time) clockBatch {
	elapsed := now.Sub(c.last)
	if elapsed < 0 {
		return clockBatch{}
	}
	c.last = now
	debt := elapsed + c.remainder
	due := int64(debt / tickPeriod)
	c.remainder = debt % tickPeriod
	batch := clockBatch{elapsed: elapsed, lag: max(0, debt-tickPeriod)}
	if due > maxStepsPerWake {
		batch.dropped = due - maxStepsPerWake
		due = maxStepsPerWake
	}
	batch.steps = int(due)
	return batch
}
