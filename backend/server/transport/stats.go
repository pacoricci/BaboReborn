package transport

import "time"

const retainedTimingSamples = 7200

type Stats struct {
	Failure             string         `json:"failure,omitempty"`
	Recoveries          int            `json:"recoveries"`
	ReplacedStates      int            `json:"replacedStates"`
	DroppedCues         int            `json:"droppedCues"`
	DegradedPeers       int            `json:"degradedPeers"`
	OutstandingBytes    int            `json:"outstandingBytes"`
	ReliableRecords     int            `json:"reliableRecords"`
	JournalBytes        int            `json:"journalBytes"`
	DeliveryDisconnects map[string]int `json:"deliveryDisconnects"`
	Ticks               int            `json:"ticks"`
	LateTicks           int            `json:"lateTicks"`
	BytesIn             int64          `json:"bytesIn"`
	BytesOut            int64          `json:"bytesOut"`
	Rejected            int            `json:"rejected"`
	TickMicros          []float64      `json:"tickMicros"`
	Snapshots           int            `json:"snapshots"`
	SnapshotMicros      []float64      `json:"snapshotMicros"`
	Wakes               int            `json:"wakes"`
	CatchUpTicks        int            `json:"catchUpTicks"`
	OverloadWakes       int            `json:"overloadWakes"`
	DroppedWallTicks    int64          `json:"droppedWallTicks"`
	DroppedWallSeconds  float64        `json:"droppedWallSeconds"`
	ObservedWallSeconds float64        `json:"observedWallSeconds"`
	WakeLagMicros       []float64      `json:"wakeLagMicros"`
	Disconnects         int            `json:"disconnects"`
}

func (s *Server) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := s.stats
	v.DeliveryDisconnects = make(map[string]int, len(s.stats.DeliveryDisconnects))
	for k, n := range s.stats.DeliveryDisconnects {
		v.DeliveryDisconnects[k] = n
	}
	v.TickMicros = append([]float64(nil), v.TickMicros...)
	v.SnapshotMicros = append([]float64(nil), v.SnapshotMicros...)
	v.WakeLagMicros = append([]float64(nil), v.WakeLagMicros...)
	return v
}

func timing(samples []float64, duration time.Duration) []float64 {
	samples = append(samples, float64(duration.Nanoseconds())/1000)
	if len(samples) > retainedTimingSamples {
		samples = samples[len(samples)-retainedTimingSamples:]
	}
	return samples
}

func (s *Server) recordWake(batch clockBatch) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stats.Wakes++
	s.stats.ObservedWallSeconds += batch.elapsed.Seconds()
	if batch.elapsed > tickPeriod*3/2 {
		s.stats.LateTicks++
	}
	if batch.dropped > 0 {
		s.stats.OverloadWakes++
		s.stats.DroppedWallTicks += batch.dropped
		s.stats.DroppedWallSeconds += (time.Duration(batch.dropped) * tickPeriod).Seconds()
	}
	s.stats.WakeLagMicros = timing(s.stats.WakeLagMicros, batch.lag)
}

func (s *Server) recordStep(duration time.Duration, catchUp bool, snapshotTime *time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stats.Ticks++
	if catchUp {
		s.stats.CatchUpTicks++
	}
	s.stats.TickMicros = timing(s.stats.TickMicros, duration)
	if snapshotTime != nil {
		s.stats.Snapshots++
		s.stats.SnapshotMicros = timing(s.stats.SnapshotMicros, *snapshotTime)
	}
}

func (r *roomRuntime) recordUsage() {
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	stats := &r.s.stats
	stats.OutstandingBytes, stats.ReliableRecords, stats.DegradedPeers = 0, 0, 0
	for _, p := range r.peers {
		u, err := r.replica.Usage(p.id)
		if err != nil {
			continue
		}
		stats.OutstandingBytes += u.OutstandingBytes
		stats.ReliableRecords += u.ReliableRecords
		stats.ReplacedStates += u.ReplacedStates - p.replaced
		stats.DroppedCues += u.DroppedCues - p.dropped
		p.replaced, p.dropped = u.ReplacedStates, u.DroppedCues
		if u.RateHz > 0 && u.RateHz < 30 {
			stats.DegradedPeers++
		}
	}
	stats.JournalBytes = r.replica.UsageRoom().JournalBytes
}
