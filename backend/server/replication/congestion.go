package replication

import "time"

// Pace declares the publisher cadence and enables lower rates for congested
// peers. Healthy peers already receive at most one state per publication; a
// second wall-clock gate would accumulate encoding/scheduling jitter as losses.
func (r *Room) Pace(hz int)   { r.cadence = hz }
func (r *Room) TimeMS() int64 { return r.clock().Sub(r.started).Milliseconds() }

// TimeOrigin lets transport traces use exactly the envelope clock's epoch.
func (r *Room) TimeOrigin() time.Time { return r.started }
func (r *Room) Ready(id, generation int) bool {
	p, err := r.active(id)
	return err == nil && !p.installing && p.installed == generation && p.generation == generation
}

// Buffered world commands must not run when the uplink resumes ahead of its
// first receipt. Probes and receipts remain available to trigger installation.
func (r *Room) AcceptCommands(id, generation int) bool {
	p, err := r.active(id)
	return err == nil && r.Ready(id, generation) && !p.stalled && !p.recovery
}
func (r *Room) Generation(id int) int {
	if p := r.peers[id]; p != nil {
		return p.generation
	}
	return 0
}
func (r *Room) Recover(id int) bool {
	p, err := r.active(id)
	return err == nil && !p.installing && p.recovery
}

func (r *Room) congestion(p *peer, now time.Time) {
	if r.cadence == 0 || p.installing {
		return
	}
	lag := time.Duration(0)
	if len(p.ledger) > 0 {
		lag = now.Sub(p.ledger[0].at)
	}
	if p.writing != 0 {
		lag = max(lag, now.Sub(p.writeStarted))
	}
	if oldest := r.oldestRequired(p); !oldest.IsZero() {
		lag = max(lag, now.Sub(oldest))
	}
	// Compare growing delay with this peer's best processing round trip. A
	// stable high RTT alone must not continuously trigger reinstalls.
	baseline := p.bestReceipt
	if lag > baseline+congestionStallDelay {
		p.stalled = true
		p.rate = min(r.cadence, congestionStallHz)
		p.healthySince = time.Time{}
	} else if lag > baseline+congestionSlowDelay {
		p.rate = min(r.cadence, congestionSlowHz)
		p.healthySince = time.Time{}
	} else {
		if p.rate == 0 {
			p.rate = r.cadence
		}
		if p.healthySince.IsZero() {
			p.healthySince = now
		}
		if now.Sub(p.healthySince) >= recoveryInterval {
			p.rate = min(r.cadence, p.rate+recoveryStepHz)
			p.healthySince = now
		}
	}
}
