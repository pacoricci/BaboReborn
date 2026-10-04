package replication

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

type candidate struct {
	encoded             []byte
	kind                Kind
	body                []byte
	through, generation int
	control             *control
	state               *checkpoint
	standings           bool
}

// Next commits one write only when the writer asks for it. There is no FIFO of
// prepared state frames. A second call cannot reserve work until Written returns.
func (r *Room) Next(id int) (*Packet, error) {
	p, err := r.active(id)
	if err != nil {
		return nil, err
	}
	r.expire(p, r.clock())
	if p.closed != "" {
		return nil, ErrPeer
	}
	if p.writing != 0 {
		return nil, nil
	}
	now := r.clock()
	gameReady := !p.installing
	tryControl := func() (*Packet, error) {
		if len(p.controls) == 0 {
			return nil, nil
		}
		c := &p.controls[0]
		kind, gen := Control, p.sentGeneration
		if c.installation != nil {
			kind, gen = Installation, c.generation
		}
		return r.commit(p, candidate{kind: kind, body: c.body, through: p.sentThrough, generation: gen, control: c}, now)
	}
	if p.controlBurst < 2 || !gameReady {
		if packet, err := tryControl(); packet != nil || err != nil {
			return packet, err
		}
	}
	if p.probe != nil && (p.controlBurst < 2 || !gameReady) {
		if packet, err := r.commit(p, candidate{kind: Probe, body: p.probe.body, through: p.sentThrough, generation: p.sentGeneration}, now); packet != nil || err != nil {
			return packet, err
		}
	}
	if gameReady && p.bytes < r.limits.WindowBytes-r.limits.ControlReserveBytes && len(p.ledger) < r.limits.WindowFrames-r.limits.ControlReserveFrames {
		for offset := 0; offset < 3; offset++ {
			class := (p.nextClass + offset) % 3
			var c candidate
			switch class {
			case 0:
				if p.pending == nil || r.cadence > 0 && p.rate < r.cadence && now.Add(statePacingSlack).Before(p.nextState) {
					continue
				}
				var err error
				c, err = p.pending.selectState(p, now)
				if err != nil {
					r.close(p, EncodingFailed)
					return nil, err
				}
			case 1:
				var err error
				c, err = r.events(p, now)
				if err != nil {
					reason := EncodingFailed
					if errors.Is(err, ErrProducerLimit) {
						reason = ProducerOverload
					}
					r.close(p, reason)
					return nil, err
				}
				if c.body == nil {
					continue
				}
			case 2:
				if p.cues == nil || p.cues.tick > p.stateTick {
					continue
				}
				body, err := eventBody(p.cues.tick, p.sentThrough, p.sentThrough, []json.RawMessage{}, p.cues.body)
				if err != nil {
					return nil, err
				}
				c = candidate{kind: Cues, body: body, through: p.sentThrough, generation: p.sentGeneration}
			}
			packet, err := r.commit(p, c, now)
			if packet != nil {
				p.nextClass = (class + 1) % 3
			}
			if packet != nil || err != nil {
				return packet, err
			}
		}
	}
	if packet, err := tryControl(); packet != nil || err != nil {
		return packet, err
	}
	if p.probe != nil {
		return r.commit(p, candidate{kind: Probe, body: p.probe.body, through: p.sentThrough, generation: p.sentGeneration}, now)
	}
	return nil, nil
}

func (r *Room) envelope(p *peer, c candidate, now time.Time) Envelope {
	return Envelope{Connection: p.connection, Sequence: p.sequence + 1, Generation: c.generation, EventThrough: c.through, SentAtMS: now.Sub(r.started).Milliseconds(), Kind: c.kind, Body: c.body}
}

func (r *Room) events(p *peer, now time.Time) (candidate, error) {
	if p.sentThrough >= p.stateCut {
		return candidate{}, nil
	}
	upper := p.stateCut
	picked := make([]record, 0, min(r.limits.EventBatchRecords, p.reliableRecords, r.journalCount))
	through := upper
	payloadBytes := 0
	for _, rec := range r.journal[r.after(p.sentThrough):] {
		if rec.id > upper {
			break
		}
		if rec.waiting&(1<<p.slot) == 0 {
			continue
		}
		if rec.tick > p.stateTick {
			return candidate{}, fmt.Errorf("event preceded state checkpoint")
		}
		if len(picked) == r.limits.EventBatchRecords || payloadBytes+len(rec.body) > r.limits.EventBatchBytes {
			through = rec.id - 1
			break
		}
		picked = append(picked, rec)
		payloadBytes += len(rec.body)
	}
	for {
		payloads := make([]json.RawMessage, 0, len(picked))
		for _, rec := range picked {
			payloads = append(payloads, rec.body)
		}
		body, err := eventBody(p.stateTick, p.sentThrough, through, payloads, json.RawMessage(`[]`))
		if err != nil {
			return candidate{}, err
		}
		c := candidate{kind: Events, body: body, through: through, generation: p.sentGeneration}
		data, err := r.encode(r.envelope(p, c, now))
		if err != nil {
			return candidate{}, err
		}
		if len(data) <= r.limits.EventBatchBytes {
			c.encoded = data
			return c, nil
		}
		if len(picked) <= 1 {
			return candidate{}, ErrProducerLimit
		}
		// Leave room for actual encoded headers without repeatedly serializing a
		// nearly identical oversized batch. Halving bounds retries for any encoder.
		keep := len(picked) / 2
		through = picked[keep].id - 1
		picked = picked[:keep]
	}
}

func (r *Room) commit(p *peer, c candidate, now time.Time) (*Packet, error) {
	if p.sequence >= maxSequence {
		r.close(p, ProducerOverload)
		return nil, ErrProducerLimit
	}
	envelope := r.envelope(p, c, now)
	data := c.encoded
	var err error
	if data == nil {
		data, err = r.encode(envelope)
	}
	if err != nil {
		r.close(p, EncodingFailed)
		return nil, err
	}
	if len(data) == 0 || len(data) > r.limits.FrameBytes {
		r.close(p, ProducerOverload)
		return nil, ErrProducerLimit
	}
	maxBytes, maxFrames := r.limits.WindowBytes, r.limits.WindowFrames
	if c.kind == State || c.kind == Events || c.kind == Cues {
		maxBytes -= r.limits.ControlReserveBytes
		maxFrames -= r.limits.ControlReserveFrames
	}
	if len(data) > maxBytes {
		r.close(p, ProducerOverload)
		return nil, ErrProducerLimit
	}
	if p.bytes+len(data) > maxBytes || len(p.ledger) >= maxFrames {
		return nil, nil
	}
	deadline := now.Add(r.limits.StallAge)
	if required := r.oldestRequired(p); !required.IsZero() && required.Add(r.limits.ReliableAge).Before(deadline) {
		deadline = required.Add(r.limits.ReliableAge)
	}
	f := flight{at: now, sequence: envelope.Sequence, generation: c.generation, through: c.through, bytes: len(data)}
	if len(p.ledger) == 0 {
		p.progress = now
	}
	if c.control != nil {
		f.controlBytes = len(c.control.body)
		f.controlAt = c.control.at
		if c.control.installation != nil {
			checkpoint := c.control.installation
			p.sentGeneration = c.generation
			p.stateTick = checkpoint.tick
			p.stateCut = checkpoint.cut
			p.retainState(checkpoint, now, true)
			if p.pending != nil && p.pending.tick <= checkpoint.tick {
				p.pending = nil
			}
		}
		p.controls[0] = control{}
		p.controls = p.controls[1:]
		p.controlBurst++
	} else if c.kind == Probe {
		p.probe = nil
		p.controlBurst++
	} else {
		p.controlBurst = 0
		switch c.kind {
		case State:
			if r.cadence > 0 {
				p.nextState = now.Add(time.Second / time.Duration(max(1, p.rate)))
			}
			p.stateTick = c.state.tick
			p.stateCut = c.state.cut
			p.retainState(c.state, now, c.standings)
			p.pending = nil
		case Events:
			p.sentThrough = c.through
		case Cues:
			p.cues = nil
		}
	}
	p.sequence = envelope.Sequence
	p.writing = envelope.Sequence
	p.writingBytes = len(data)
	p.writeStarted = now
	p.bytes += len(data)
	p.ledger = append(p.ledger, f)
	return &Packet{Receipt: Receipt{Connection: p.connection, Sequence: envelope.Sequence, Generation: c.generation, EventThrough: c.through}, Kind: c.kind, Data: data, Deadline: deadline}, nil
}

// Written reports transport completion only. It never releases acknowledgement
// credit, an installation barrier, or an event obligation.
func (r *Room) Written(id int, receipt Receipt, writeErr error) error {
	p := r.peers[id]
	if p == nil {
		return ErrPeer
	}
	if receipt.Connection != p.connection || receipt.Sequence != p.writing || receipt.Sequence == 0 {
		return ErrPublication
	}
	r.expire(p, r.clock())
	p.writing = 0
	p.writingBytes = 0
	if writeErr != nil {
		r.close(p, WriteFailed)
	}
	if p.closed != "" {
		return ErrPeer
	}
	return nil
}

// Acknowledge consumes cumulative application processing receipts.
func (r *Room) Acknowledge(id int, a Receipt) error {
	p, err := r.active(id)
	if err != nil {
		return err
	}
	r.expire(p, r.clock())
	if p.closed != "" {
		return ErrPeer
	}
	invalid := func() error { r.close(p, InvalidReceipt); return fmt.Errorf("%s", InvalidReceipt) }
	if a.Connection != p.connection || a.Sequence < 0 {
		return invalid()
	}
	if a.Sequence <= p.ackSequence {
		return nil
	}
	index := -1
	for i, f := range p.ledger {
		if f.sequence == a.Sequence {
			index = i
			break
		}
	}
	if index < 0 {
		return invalid()
	}
	end := p.ledger[index]
	if a.Generation != end.generation || a.EventThrough != end.through {
		return invalid()
	}
	sample := r.clock().Sub(end.at)
	if p.ackSequence == 0 || sample < p.bestReceipt {
		p.bestReceipt = sample
	}
	if p.stalled && !p.installing {
		p.recovery = true
	}
	for _, f := range p.ledger[:index+1] {
		p.bytes -= f.bytes
		if f.controlBytes > 0 {
			p.reliableBytes -= f.controlBytes
			p.reliableRecords--
		}
	}
	clear(p.ledger[:index+1])
	p.ledger = p.ledger[index+1:]
	for i := r.after(p.ack); i < len(r.journal); i++ {
		rec := &r.journal[i]
		if rec.id > a.EventThrough {
			break
		}
		if rec.waiting&(1<<p.slot) != 0 {
			rec.waiting &^= 1 << p.slot
			p.reliableBytes -= len(rec.body)
			p.reliableRecords--
			if rec.waiting == 0 {
				r.journalBytes -= len(rec.body)
				r.journalCount--
				rec.body = nil
			}
		}
	}
	p.ack = a.EventThrough
	p.ackSequence = a.Sequence
	p.installed = a.Generation
	p.progress = r.clock()
	if p.installed == p.generation {
		p.installing = false
	}
	if r.journalCount == 0 {
		r.collect()
	}
	return nil
}

func (r *Room) oldestRequired(p *peer) time.Time {
	var oldest time.Time
	if p.reliableRecords == 0 {
		return oldest
	}
	add := func(at time.Time) {
		if !at.IsZero() && (oldest.IsZero() || at.Before(oldest)) {
			oldest = at
		}
	}
	if len(p.controls) > 0 {
		add(p.controls[0].at)
	}
	for _, f := range p.ledger {
		add(f.controlAt)
	}
	for _, rec := range r.journal[r.after(p.ack):] {
		if rec.waiting&(1<<p.slot) != 0 {
			add(rec.at)
			break
		}
	}
	return oldest
}

// Expire must be called by the owner's periodic wake even with no new state or
// writer completion. A probe receipt cannot extend an older required deadline.
func (r *Room) Expire() {
	now := r.clock()
	for _, p := range r.peers {
		r.expire(p, now)
	}
}
func (r *Room) expire(p *peer, now time.Time) {
	if p.closed != "" {
		return
	}
	r.congestion(p, now)
	if p.cues != nil && now.Sub(p.cues.at) >= r.limits.CueAge {
		p.cues = nil
		p.dropped++
	}
	if p.probe != nil && now.Sub(p.probe.at) >= r.limits.ProbeAge {
		p.probe = nil
	}
	if oldest := r.oldestRequired(p); !oldest.IsZero() && now.Sub(oldest) >= r.limits.ReliableAge {
		r.close(p, ReliableTimeout)
		return
	}
	if len(p.ledger) > 0 && now.Sub(p.progress) >= r.limits.StallAge || p.writing != 0 && now.Sub(p.writeStarted) >= r.limits.StallAge {
		r.close(p, DeliveryStalled)
	}
}
