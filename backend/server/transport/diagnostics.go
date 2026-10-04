package transport

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"baboreborn/backend/identity"
)

const traceCapacity = 32768
const traceDuration = 120 * time.Second

// One explicitly requested connection, metadata only. The socket goroutines
// record their own timestamps without reading mutable world/replica state.
type traceSample struct {
	AtMS              float64 `json:"atMs"`
	Kind              string  `json:"kind"`
	Sequence          int     `json:"sequence,omitempty"`
	Generation        int     `json:"generation,omitempty"`
	Tick              int     `json:"tick,omitempty"`
	Ack               int     `json:"ack,omitempty"`
	Count             int     `json:"count,omitempty"`
	Queued            int     `json:"queued"`
	Bytes             int     `json:"bytes,omitempty"`
	RateHz            int     `json:"rateHz,omitempty"`
	OutstandingFrames int     `json:"outstandingFrames,omitempty"`
	OutstandingBytes  int     `json:"outstandingBytes,omitempty"`
	ReplacedStates    int     `json:"replacedStates,omitempty"`
	DroppedCues       int     `json:"droppedCues,omitempty"`
	DurationMS        float64 `json:"durationMs,omitempty"`
	WaitMS            float64 `json:"waitMs,omitempty"`
	Failed            bool    `json:"failed,omitempty"`
}

func (r *roomRuntime) traceInputQueues() {
	if !r.s.trace.enabled.Load() {
		return
	}
	for _, p := range r.peers {
		player := r.s.world.Find(p.id)
		if player == nil || player.Status != "alive" {
			continue
		}
		empty := player.PendingInputs() == 0
		if empty != p.inputEmpty || p.inputTrace != r.s.trace.serial.Load() {
			kind := "input_available"
			if empty {
				kind = "input_empty"
			}
			r.s.trace.record(p.connection, r.now(), traceSample{Kind: kind, Tick: r.s.world.Tick + 1, Ack: player.Ack, Queued: player.PendingInputs()})
			p.inputEmpty = empty
			p.inputTrace = r.s.trace.serial.Load()
		}
	}
}

type deliveryTrace struct {
	enabled    atomic.Bool
	serial     atomic.Uint64
	mu         sync.Mutex
	origin     time.Time
	started    time.Time
	until      time.Time
	connection string
	samples    []traceSample
	head       int
	evictions  int
}

func (t *deliveryTrace) record(connection string, at time.Time, sample traceSample) {
	if !t.enabled.Load() {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if at.Before(t.started) {
		return
	}
	if !at.Before(t.until) {
		t.enabled.Store(false)
		return
	}
	if t.connection == "" {
		t.connection = connection
	}
	if connection != t.connection {
		return
	}
	sample.AtMS = float64(at.Sub(t.origin).Nanoseconds()) / 1e6
	if len(t.samples) < traceCapacity {
		t.samples = append(t.samples, sample)
	} else {
		t.samples[t.head] = sample
		t.head = (t.head + 1) % traceCapacity
		t.evictions++
	}
}

// Only a local operator can start/read traces, and the executable must opt in.
// Do not trust proxy headers or browser Origins; in Docker run the request
// inside the container namespace.
func (s *Server) diagnostics(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() || r.Header.Get("Origin") != "" {
		identity.Error(w, http.StatusForbidden, "local_diagnostics_only")
		return
	}
	t := &s.trace
	t.mu.Lock()
	now := time.Now()
	if r.Method == http.MethodPost {
		if t.enabled.Load() && now.Before(t.until) {
			t.mu.Unlock()
			identity.Error(w, http.StatusConflict, "diagnostics_collecting")
			return
		}
		connection := r.URL.Query().Get("connection")
		if len(connection) > 128 {
			t.mu.Unlock()
			identity.Error(w, http.StatusBadRequest, "invalid_connection")
			return
		}
		t.connection, t.started, t.until = connection, now, now.Add(traceDuration)
		t.samples = make([]traceSample, 0, traceCapacity)
		t.head, t.evictions = 0, 0
		t.serial.Add(1)
		t.enabled.Store(true)
	} else if r.Method != http.MethodGet {
		t.mu.Unlock()
		w.Header().Set("Allow", "GET, POST")
		identity.Error(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !now.Before(t.until) {
		t.enabled.Store(false)
	}
	samples := make([]traceSample, 0, len(t.samples))
	samples = append(samples, t.samples[t.head:]...)
	samples = append(samples, t.samples[:t.head]...)
	result := struct {
		Format            string        `json:"format"`
		Connection        string        `json:"connection"`
		Collecting        bool          `json:"collecting"`
		StartedAt         time.Time     `json:"startedAt"`
		EndsAt            time.Time     `json:"endsAt"`
		Capacity          int           `json:"capacity"`
		CapacityEvictions int           `json:"capacityEvictions"`
		Samples           []traceSample `json:"samples"`
	}{"baboreborn-delivery-trace-v1", t.connection, t.enabled.Load(), t.started, t.until, traceCapacity, t.evictions, samples}
	t.mu.Unlock()
	// Export cannot hold up the room owner or socket writer on a slow reader.
	sort.SliceStable(samples, func(i, j int) bool { return samples[i].AtMS < samples[j].AtMS })
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Diagnostic export: %v", err)
	}
}
