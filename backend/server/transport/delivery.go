package transport

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

// The delivery adapter runs on the room owner. Writer callbacks only exchange
// requests and completions; they never access the world or replica directly.
type deliveryRequest struct {
	peer    *peer
	receipt *replication.Receipt
	err     error
	done    chan deliveryResult
	at      time.Time
}
type deliveryResult struct {
	packet *replication.Packet
	err    error
}

func (s *Server) deliver(ctx context.Context, request deliveryRequest) deliveryResult {
	request.at = time.Now()
	request.done = make(chan deliveryResult, 1)
	select {
	case s.delivery <- request:
	case <-s.done:
		return deliveryResult{err: errRoomStopped}
	case <-ctx.Done():
		return deliveryResult{err: ctx.Err()}
	}
	select {
	case result := <-request.done:
		return result
	case <-s.done:
		return deliveryResult{err: errRoomStopped}
	case <-ctx.Done():
		return deliveryResult{err: ctx.Err()}
	}
}

func (r *roomRuntime) transfer() error {
	w := r.s.world
	if w.EventCut() == w.EventFrom() {
		return nil
	}
	b := wire.CaptureRequiredEvents(w)
	if err := r.replica.Append(b); err != nil {
		return err
	}
	w.DrainRequiredEvents()
	return nil
}

func (r *roomRuntime) closeDelivery(p *peer) error {
	u, err := r.replica.Usage(p.id)
	if err != nil {
		return err
	}
	r.remove(p, CloseRemoved, string(u.Closed))
	return nil
}

// installation is the welcome, map or resync baseline body. Fields follow the
// key order of the versioned delivery fixture.
type installation struct {
	Activities   []wire.Activity        `json:"activities"`
	Arena        match.Arena            `json:"arena"`
	EventCut     int                    `json:"eventCut"`
	ID           int                    `json:"id"`
	Round        int                    `json:"round"`
	ShotGeometry core.ShotGeometry      `json:"shotGeometry"`
	SnapshotHz   int                    `json:"snapshotHz"`
	State        wire.RecipientSnapshot `json:"state"`
	Tick         int                    `json:"tick"`
	TickHz       int                    `json:"tickHz"`
	Type         string                 `json:"type"`
	Version      int                    `json:"version"`
}

func (r *roomRuntime) install(p *peer) error {
	w := r.s.world
	if err := r.transfer(); err != nil {
		return err
	}
	if !r.replica.Ready(p.id, r.replica.Generation(p.id)) && p.round != 0 {
		p.install = true
		return nil
	}
	w.Release(w.Find(p.id))
	state := wire.Capture(w)
	kind := "resync"
	if p.round == 0 {
		kind = "welcome"
	} else if p.round+1 == w.Match.Round {
		kind = "map"
	}
	body := encode(installation{
		Activities:   wire.CaptureActivities(w),
		Arena:        w.Arena,
		EventCut:     state.EventCut,
		ID:           p.id,
		Round:        w.Match.Round,
		ShotGeometry: match.Geometry,
		SnapshotHz:   gameconfig.TickHz / match.SnapshotEvery,
		State:        state.ForRecipient(p.id),
		Tick:         w.Tick,
		TickHz:       gameconfig.TickHz,
		Type:         kind,
		Version:      gameconfig.ProtocolVersion,
	})
	baseline := replication.Baseline{State: state, Body: body}
	var err error
	if p.round == 0 {
		err = r.replica.Add(p.id, p.connection, baseline)
	} else {
		err = r.replica.Install(p.id, baseline)
	}
	if err != nil {
		return err
	}
	if kind == "resync" {
		r.s.mu.Lock()
		r.s.stats.Recoveries++
		r.s.mu.Unlock()
	}
	p.round, p.install, p.lastResync = w.Match.Round, false, r.now()
	return nil
}
func (r *roomRuntime) pump() error {
	r.replica.Expire()
	for _, p := range r.peers {
		u, err := r.replica.Usage(p.id)
		if err != nil {
			return err
		}
		if u.Closed != "" {
			r.remove(p, CloseRemoved, string(u.Closed))
			continue
		}
		if p.round != r.s.world.Match.Round || r.replica.Recover(p.id) || p.install && r.now().Sub(p.lastResync) >= time.Second {
			if err := r.install(p); err != nil {
				if errors.Is(err, replication.ErrPeer) {
					if err := r.closeDelivery(p); err != nil {
						return err
					}
					continue
				}
				return err
			}
		}
		if p.waiter == nil {
			continue
		}
		collecting := r.s.trace.enabled.Load()
		var selectedAt time.Time
		if collecting {
			selectedAt = r.now()
		}
		packet, err := r.replica.Next(p.id)
		if packet != nil || err != nil {
			if packet != nil {
				if collecting {
					r.s.trace.record(p.connection, r.now(), traceSample{Kind: "selected_" + string(packet.Kind), Sequence: packet.Receipt.Sequence, Generation: packet.Receipt.Generation, Bytes: len(packet.Data), DurationMS: float64(r.now().Sub(selectedAt).Nanoseconds()) / 1e6, RateHz: u.RateHz, OutstandingFrames: u.OutstandingFrames, OutstandingBytes: u.OutstandingBytes, ReplacedStates: u.ReplacedStates, DroppedCues: u.DroppedCues})
				}
				packet.Deadline = time.Now().Add(packet.Deadline.Sub(r.now()))
			}
			p.waiter <- deliveryResult{packet, err}
			p.waiter = nil
			if err != nil {
				if err := r.closeDelivery(p); err != nil {
					return err
				}
			}
		}
	}
	r.recordUsage()
	return nil
}
func encodeDelivery(e replication.Envelope) ([]byte, error) {
	if e.Kind == replication.State {
		return wire.EncodeStateDelivery(e.Connection, e.Sequence, e.Generation, e.EventThrough, e.SentAtMS, e.Body)
	}

	return json.Marshal(struct {
		Type    string `json:"type"`
		Version int    `json:"version"`
		replication.Envelope
		Body json.RawMessage `json:"body"`
	}{"delivery", gameconfig.ProtocolVersion, e, json.RawMessage(e.Body)})
}

// Administrative operations originate outside the room clock. Convert their
// absolute deadline once, before retained delivery can delay the notification.
func (r *roomRuntime) notice(value Notice) []byte {
	notice := map[string]any{"type": "administration", "action": value.Action}
	if value.Operation != "" {
		notice["operation"] = value.Operation
	}
	if !value.Deadline.IsZero() {
		notice["deadlineAtMs"] = max(int64(0), r.replica.TimeMS()+time.Until(value.Deadline).Milliseconds())
	}
	return encode(notice)
}
