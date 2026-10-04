package replication

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/wire"
)

type checkpoint struct {
	payload          wire.SnapshotParts
	dynamicPlayers   []byte
	locals           map[int][]byte
	groups           stateGroups
	size             int
	round, tick, cut int
}
type transient struct {
	body        []byte
	round, tick int
	at          time.Time
}
type control struct {
	body         []byte
	at           time.Time
	installation *checkpoint
	generation   int
}
type record struct {
	body     []byte
	id, tick int
	waiting  uint16
	at       time.Time
}
type flight struct {
	at                                   time.Time
	sequence, generation, through, bytes int
	controlBytes                         int
	controlAt                            time.Time
}
type peer struct {
	rate                                       int
	nextState, healthySince                    time.Time
	bestReceipt                                time.Duration
	stalled, recovery                          bool
	id, slot                                   int
	connection                                 string
	pending                                    *checkpoint
	groups                                     stateGroups
	phase                                      string
	nextStandings                              time.Time
	cues, probe                                *transient
	controls                                   []control
	ledger                                     []flight
	ack, sentThrough, sequence, ackSequence    int
	generation, sentGeneration, installed      int
	stateTick, stateCut, round                 int
	installing                                 bool
	bytes, reliableBytes, reliableRecords      int
	writing, writingBytes                      int
	writeStarted                               time.Time
	progress                                   time.Time
	nextClass, controlBurst, replaced, dropped int
	closed                                     Reason
}

type Room struct {
	cadence                    int
	limits                     Limits
	encode                     Encoder
	now                        func() time.Time
	started, last              time.Time
	peers                      map[int]*peer
	journal                    []record
	journalBytes, journalCount int
	cut, captureTick           int
	latest                     *checkpoint
}

func New(limits Limits, now func() time.Time, encode Encoder) (*Room, error) {
	if err := limits.validate(); err != nil {
		return nil, err
	}
	if now == nil || encode == nil {
		return nil, fmt.Errorf("replication needs a clock and encoder")
	}
	start := now()
	return &Room{limits: limits, encode: encode, now: now, started: start, last: start, peers: make(map[int]*peer)}, nil
}
func (r *Room) clock() time.Time {
	now := r.now()
	if now.Before(r.last) {
		return r.last
	}
	r.last = now
	return now
}

func (r *Room) Add(id int, connection string, baseline Baseline) error {
	if id <= 0 || id > maxSequence || connection == "" || len(connection) > 128 || r.peers[id] != nil || len(r.peers) >= r.limits.Peers {
		return ErrPeer
	}
	used := uint16(0)
	for _, p := range r.peers {
		if p.connection == connection {
			return ErrPeer
		}
		used |= 1 << p.slot
	}
	slot := 0
	for used&(1<<slot) != 0 {
		slot++
	}
	p := &peer{id: id, slot: slot, connection: connection, ack: r.cut, sentThrough: r.cut, progress: r.clock()}
	r.peers[id] = p
	if err := r.Install(id, baseline); err != nil {
		delete(r.peers, id)
		return err
	}
	return nil
}

func (r *Room) Install(id int, b Baseline) error {
	p, err := r.active(id)
	if err != nil {
		return err
	}
	if p.installing {
		return ErrInstallationPending
	}
	if p.generation >= maxSequence {
		r.close(p, ProducerOverload)
		return ErrProducerLimit
	}
	s := b.State
	if s.EventCut != r.cut || s.Tick < p.stateTick || s.Match.Round < p.round || s.Match.Round < 1 || s.Match.Round > maxSequence || s.Tick < 0 || s.Tick > maxSequence || len(b.Body) == 0 || !json.Valid(b.Body) {
		return ErrPublication
	}
	if len(b.Body) > r.limits.FrameBytes {
		return ErrProducerLimit
	}
	c, err := captureCheckpoint(s, r.latest)
	if err != nil {
		return err
	}
	if c.size > r.limits.StateBytes {
		return ErrProducerLimit
	}
	p.generation++
	p.installing = true
	p.recovery, p.stalled = false, false
	p.nextState = time.Time{}
	p.round = c.round
	p.pending = nil
	if p.cues != nil {
		p.dropped++
		p.cues = nil
	}
	return r.control(p, control{body: bytes.Clone(b.Body), at: r.clock(), installation: c, generation: p.generation})
}

func (r *Room) Notify(id int, body json.RawMessage) error {
	p, err := r.active(id)
	if err != nil {
		return err
	}
	if len(body) == 0 || !json.Valid(body) {
		return ErrPublication
	}
	if len(body) > r.limits.FrameBytes {
		return ErrProducerLimit
	}
	return r.control(p, control{body: bytes.Clone(body), at: r.clock()})
}
func (r *Room) control(p *peer, c control) error {
	if len(p.controls) >= r.limits.Controls || p.reliableBytes+len(c.body) > r.limits.ReliableBytes || p.reliableRecords+1 > r.limits.ReliableRecords {
		r.close(p, BacklogExceeded)
		return ErrPeer
	}
	p.controls = append(p.controls, c)
	p.reliableBytes += len(c.body)
	p.reliableRecords++
	return nil
}

// Publish replaces only unsent state. Event capture/Append is independent and
// must happen first through this checkpoint's cut, even on ticks without state.
func (r *Room) Publish(s wire.Snapshot) error {
	if s.Tick < 0 || s.Tick > maxSequence || s.EventCut > r.cut || s.EventCut < 0 || s.Match.Round < 1 || s.Match.Round > maxSequence || r.latest != nil && (s.Tick <= r.latest.tick || s.Match.Round < r.latest.round || s.EventCut < r.latest.cut) {
		return ErrPublication
	}
	c, err := captureCheckpoint(s, r.latest)
	if err != nil {
		return err
	}
	if c.size > r.limits.StateBytes {
		return ErrProducerLimit
	}
	r.latest = c
	for _, p := range r.peers {
		if p.closed != "" || p.round != c.round || c.tick <= p.stateTick {
			continue
		}
		if p.pending != nil {
			p.replaced++
		}
		p.pending = c
	}
	return nil
}

// Append accepts the complete room stream, before any recipient filtering. No
// required payload is truncated: exceeding a recipient's budget closes it.
func (r *Room) Append(b wire.EventBatch) error {
	if b.After != r.cut || b.Through < b.After || b.Through > maxSequence || len(b.Events) != b.Through-b.After || b.Tick < r.captureTick || b.Tick > maxSequence {
		return ErrPublication
	}
	if len(b.Events) > r.limits.JournalEvents {
		return ErrProducerLimit
	}
	now := r.clock()
	incoming := make([]record, 0, len(b.Events))
	size := 0
	for i, e := range b.Events {
		if e.ID != b.After+i+1 || e.Tick > b.Tick || e.Tick < 0 || e.Round < 1 || e.Round > maxSequence {
			return ErrPublication
		}
		body, err := json.Marshal(e)
		if err != nil {
			return err
		}
		if len(body) > r.limits.EventBytes {
			return ErrProducerLimit
		}
		incoming = append(incoming, record{body: body, id: e.ID, tick: e.Tick, at: now})
		size += len(body)
		if size > r.limits.JournalBytes {
			return ErrProducerLimit
		}
	}
	r.Expire()
	for i, e := range b.Events {
		rec := &incoming[i]
		for _, p := range r.peers {
			if p.closed != "" || !e.AddressedTo(p.id) {
				continue
			}
			if p.reliableBytes+len(rec.body) > r.limits.ReliableBytes || p.reliableRecords+1 > r.limits.ReliableRecords {
				r.close(p, BacklogExceeded)
				continue
			}
			rec.waiting |= 1 << p.slot
			p.reliableBytes += len(rec.body)
			p.reliableRecords++
		}
	}
	// Closing a peer above also releases its obligations in this not-yet-added batch.
	active := uint16(0)
	for _, p := range r.peers {
		if p.closed == "" {
			active |= 1 << p.slot
		}
	}
	for i := range incoming {
		incoming[i].waiting &= active
	}
	// Acknowledgements release payloads immediately; compact metadata only when
	// needed for space. One slow peer must not cause a full scan on every receipt.
	if len(r.journal)+r.retainedCount(incoming) > r.limits.JournalEvents || r.journalBytes+r.retainedBytes(incoming) > r.limits.JournalBytes {
		r.collect()
	}
	for r.retainedCount(incoming)+r.journalCount > r.limits.JournalEvents || r.retainedBytes(incoming)+r.journalBytes > r.limits.JournalBytes {
		if len(r.journal) == 0 {
			return ErrProducerLimit
		}
		// The oldest obligation identifies the peers pinning the shared journal.
		mask := r.journal[0].waiting
		for _, p := range r.peers {
			if mask&(1<<p.slot) != 0 {
				r.close(p, BacklogExceeded)
				active &^= 1 << p.slot
			}
		}
		for i := range incoming {
			incoming[i].waiting &= active
		}
	}
	for _, rec := range incoming {
		if rec.waiting == 0 {
			continue
		}
		r.journal = append(r.journal, rec)
		r.journalBytes += len(rec.body)
		r.journalCount++
	}
	r.cut, r.captureTick = b.Through, b.Tick
	return nil
}
func (r *Room) retainedCount(records []record) int {
	n := 0
	for _, v := range records {
		if v.waiting != 0 {
			n++
		}
	}
	return n
}
func (r *Room) retainedBytes(records []record) int {
	n := 0
	for _, v := range records {
		if v.waiting != 0 {
			n += len(v.body)
		}
	}
	return n
}

func (r *Room) OfferCues(round, tick int, cues []wire.Cue, occurredAt time.Time) error {
	now := r.clock()
	if occurredAt.After(now) || round < 1 || round > maxSequence || tick < 0 || tick > maxSequence {
		return ErrPublication
	}
	if len(cues) == 0 {
		return nil
	}
	last := 0
	for _, c := range cues {
		if c.ID <= last || c.ID > maxSequence || c.Round != round || c.Tick > tick || c.Tick < 0 {
			return ErrPublication
		}
		last = c.ID
	}
	body, err := json.Marshal(cues)
	if err != nil {
		return err
	}
	if len(body) > r.limits.CueBytes || now.Sub(occurredAt) >= r.limits.CueAge {
		return nil
	}
	c := &transient{body: body, round: round, tick: tick, at: occurredAt}
	for _, p := range r.peers {
		if p.closed != "" || p.round != round || p.cues != nil && p.cues.tick > tick {
			continue
		}
		if p.cues != nil {
			p.dropped++
		}
		p.cues = c
	}
	return nil
}
func (r *Room) OfferProbe(id int, body json.RawMessage, occurredAt time.Time) error {
	p, err := r.active(id)
	if err != nil {
		return err
	}
	now := r.clock()
	if occurredAt.After(now) || len(body) == 0 || !json.Valid(body) {
		return ErrPublication
	}
	if len(body) > r.limits.ProbeBytes {
		return ErrProducerLimit
	}
	if now.Sub(occurredAt) >= r.limits.ProbeAge {
		return nil
	}
	p.probe = &transient{body: bytes.Clone(body), at: occurredAt}
	return nil
}

func (r *Room) active(id int) (*peer, error) {
	p := r.peers[id]
	if p == nil || p.closed != "" {
		return nil, ErrPeer
	}
	return p, nil
}
func (r *Room) close(p *peer, reason Reason) {
	if p.closed != "" {
		return
	}
	p.closed = reason
	p.groups = stateGroups{}
	p.pending = nil
	p.cues = nil
	p.probe = nil
	p.controls = nil
	p.ledger = nil
	p.bytes = 0
	p.reliableBytes = 0
	p.reliableRecords = 0
	for i := range r.journal {
		r.journal[i].waiting &^= 1 << p.slot
	}
	r.collect()
}
func (r *Room) Remove(id int) {
	if p := r.peers[id]; p != nil {
		r.close(p, WriteFailed)
		delete(r.peers, id)
	}
}
func (r *Room) collect() {
	kept := r.journal[:0]
	size := 0
	for _, rec := range r.journal {
		if rec.waiting != 0 {
			kept = append(kept, rec)
			size += len(rec.body)
		}
	}
	clear(r.journal[len(kept):])
	r.journal = kept
	r.journalBytes = size
	r.journalCount = len(kept)
}

func (r *Room) after(cut int) int {
	return sort.Search(len(r.journal), func(i int) bool { return r.journal[i].id > cut })
}
func (r *Room) Usage(id int) (Usage, error) {
	p := r.peers[id]
	if p == nil {
		return Usage{}, ErrPeer
	}
	return Usage{PendingState: p.pending != nil, PendingCues: p.cues != nil, ReliableBytes: p.reliableBytes, ReliableRecords: p.reliableRecords, Controls: len(p.controls), OutstandingBytes: p.bytes, OutstandingFrames: len(p.ledger), WritingBytes: p.writingBytes, EventThrough: p.ack, Sequence: p.ackSequence, Generation: p.installed, ReplacedStates: p.replaced, DroppedCues: p.dropped, Closed: p.closed, RateHz: p.rate}, nil
}
func (r *Room) UsageRoom() RoomUsage {
	return RoomUsage{JournalBytes: r.journalBytes, JournalEvents: r.journalCount, Peers: len(r.peers)}
}

func eventBody(tick, after, through int, events []json.RawMessage, cues json.RawMessage) ([]byte, error) {
	return json.Marshal(struct {
		Type    string            `json:"type"`
		Version int               `json:"version"`
		Tick    int               `json:"tick"`
		After   int               `json:"after"`
		Through int               `json:"through"`
		Events  []json.RawMessage `json:"events"`
		Cues    json.RawMessage   `json:"cues"`
	}{"events", gameconfig.ProtocolVersion, tick, after, through, events, cues})
}
