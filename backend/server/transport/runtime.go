package transport

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

type roomRuntime struct {
	s             *Server
	replica       *replication.Room
	peers         map[int]*peer
	now           func() time.Time
	retained      map[string]match.Standing
	retainedRound int
}

func (r *roomRuntime) remove(p *peer, code websocket.StatusCode, reason string) {
	if r.peers[p.id] != p {
		return
	}
	if code != 0 && p.conn != nil {
		p.closing.Store(true)
	}
	r.retain(p)
	delete(r.peers, p.id)
	r.replica.Remove(p.id)
	r.s.world.Remove(p.id)
	r.s.mu.Lock()
	r.s.stats.Disconnects++
	if reason != "" {
		r.s.stats.DeliveryDisconnects[reason]++
	}
	r.s.mu.Unlock()
	if p.waiter != nil {
		p.waiter <- deliveryResult{err: replication.ErrPeer}
		p.waiter = nil
	}
	if code == 0 || p.conn == nil {
		p.cancel()
		return
	}
	// The close frame must be written before cancelling its reader context.
	// Removal from authority never waits for this bounded network handshake.
	go func() { defer p.cancel(); _ = p.conn.Close(code, reason) }() //nolint:errcheck // Best effort after authoritative removal.
}
func (r *roomRuntime) receive(in incoming) error {
	p := in.peer
	if r.peers[p.id] != p {
		return nil
	}
	if in.err != nil {
		r.remove(p, 0, "")
		return nil
	}
	m, w := in.message, r.s.world
	player := w.Find(p.id)

	switch m.Type {
	case "receipt":
		if m.Receipt == nil {
			r.remove(p, CloseRemoved, string(replication.InvalidReceipt))
			return nil
		}
		if err := r.replica.Acknowledge(p.id, *m.Receipt); err != nil {
			return r.closeDelivery(p)
		}
	case "ping":
		if m.Nonce < 0 || m.Nonce != m.Nonce {
			r.remove(p, CloseRejected, ReasonInvalidProbe)
			return nil
		}
		return r.replica.OfferProbe(p.id, encode(map[string]any{"type": "pong", "version": gameconfig.ProtocolVersion, "nonce": m.Nonce, "tick": w.Tick, "receivedAtMs": r.replica.TimeMS()}), r.now())
	default:
		if m.Generation < 1 || m.Generation > r.replica.Generation(p.id) {
			r.remove(p, CloseRejected, ReasonInvalidGeneration)
			return nil
		}
		if !r.replica.AcceptCommands(p.id, m.Generation) || p.round != w.Match.Round || p.install {
			return nil
		}
		var err error
		switch m.Type {
		case "resync":
			p.install = true
		case "input":
			err = w.Submit(player, m.Inputs)
		case "join", "respawn":
			w.Spawn(player)
		case "profile":
			err = w.SelectNickname(player, m.Nickname, m.NicknameColors)
		case "appearance":
			err = w.SelectAppearance(player, match.Appearance{Template: m.Appearance.Template, Colors: m.Appearance.Colors})
		case "select":
			err = w.Select(player, m.Primary, m.Secondary)
		case "release":
			w.Release(player)
		default:
			err = fmt.Errorf("unknown message")
		}
		if errors.Is(err, match.ErrInputBacklog) {
			p.install = true
		} else if err != nil {
			r.s.mu.Lock()
			r.s.stats.Rejected++
			r.s.mu.Unlock()
			r.remove(p, CloseRejected, ReasonInvalidInput)
			return nil
		}
	}
	if r.s.trace.enabled.Load() && (m.Type == "receipt" || m.Type == "input") {
		sample := traceSample{Kind: m.Type + "_processed", Count: len(m.Inputs), Generation: m.Generation}
		if !in.received.IsZero() {
			sample.WaitMS = float64(r.now().Sub(in.received).Nanoseconds()) / 1e6
		}
		if m.Receipt != nil {
			sample.Sequence, sample.Generation = m.Receipt.Sequence, m.Receipt.Generation
		}
		if player != nil {
			sample.Ack, sample.Queued = player.Ack, player.PendingInputs()
		}
		r.s.trace.record(p.connection, r.now(), sample)
	}
	w.Touch(player)
	return r.transfer()
}

// Tests drive the same owner with a controlled monotonic clock and wake source.
func (s *Server) run(ctx context.Context, wakes <-chan time.Time, now func() time.Time) {
	defer close(s.done)
	replica, err := replication.New(replication.DefaultLimits(), now, encodeDelivery)
	if err != nil {
		panic(err)
	}
	replica.Pace(gameconfig.TickHz / match.SnapshotEvery)
	s.trace.mu.Lock()
	s.trace.origin = replica.TimeOrigin()
	s.trace.mu.Unlock()
	r := roomRuntime{s: s, replica: replica, peers: map[int]*peer{}, now: now}
	s.mu.Lock()
	s.stats.DeliveryDisconnects = map[string]int{}
	s.mu.Unlock()
	clock := simulationClock{last: now()}
	defer func() {
		for _, p := range r.peers {
			p.cancel()
		}
	}()
	fail := func(err error) {
		for _, p := range r.peers {
			r.remove(p, CloseRemoved, string(replication.ProducerOverload))
		}
		s.mu.Lock()
		s.stats.Failure = err.Error()
		s.mu.Unlock()
		log.Printf("Room replication stopped: %v", err)
	}
	if err := r.transfer(); err != nil {
		fail(err)
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		case request := <-s.delivery:
			p := request.peer
			if r.peers[p.id] != p {
				request.done <- deliveryResult{err: replication.ErrPeer}
				continue
			}
			if request.receipt != nil {
				s.trace.record(p.connection, now(), traceSample{Kind: "written_processed", Sequence: request.receipt.Sequence, Generation: request.receipt.Generation, WaitMS: float64(now().Sub(request.at).Nanoseconds()) / 1e6, Failed: request.err != nil})
				err := replica.Written(p.id, *request.receipt, request.err)
				request.done <- deliveryResult{err: err}
			} else {
				if p.waiter != nil {
					request.done <- deliveryResult{err: fmt.Errorf("duplicate writer request")}
				} else {
					p.waiter = request.done
				}
			}
		case request := <-s.register:
			if s.retirement.Load() != nil {
				request.done <- false
				continue
			}
			s.world.TimeMS = replica.TimeMS()
			p := request.peer
			if !r.register(p) {
				request.done <- false
				continue
			}
			if err := r.install(p); err != nil {
				r.remove(p, 0, string(replication.ProducerOverload))
				request.done <- false
				continue
			}
			request.done <- true
		case in := <-s.incoming:
			s.world.TimeMS = replica.TimeMS()
			if err := r.receive(in); err != nil && !errors.Is(err, replication.ErrPeer) {
				fail(err)
				return
			}
		case request := <-s.administration:
			s.world.TimeMS = replica.TimeMS()
			command := request.command
			if command.Action == Retire {
				// The owner closes admission before removing peers, so old handlers
				// cannot register a new player after this command completes.
				s.retirement.Store(&roomClosure{code: command.Code, reason: command.Reason})
			}
			result := []Participant{}
			for _, p := range r.peers {
				if command.Subject != "" && p.identity.Subject != command.Subject || command.Session != "" && p.identity.Session != command.Session {
					continue
				}
				switch command.Action {
				case ListParticipants:
					if player := s.world.Find(p.id); player != nil {
						result = append(result, Participant{ID: p.id, Subject: p.identity.Subject, Nickname: player.Nickname, NicknameColors: player.NicknameColors})
					}
				case Disconnect, Retire:
					r.remove(p, command.Code, command.Reason)
				case Renew:
					if command.Expires.After(p.identity.Expires) {
						p.identity.Expires = command.Expires
					}
				case Notify:
					if err := replica.Notify(p.id, r.notice(command.Notice)); err != nil && !errors.Is(err, replication.ErrPeer) {
						fail(err)
						request.done <- result
						return
					}
				}
			}
			request.done <- result
		case _, open := <-wakes:
			if !open {
				return
			}
			batch := clock.advance(now())
			s.recordWake(batch)
			for i := 0; i < batch.steps; i++ {
				if ctx.Err() != nil {
					return
				}
				start := time.Now()
				s.world.TimeMS = replica.TimeMS()
				r.traceInputQueues()
				s.world.Step()
				r.clearPreviousRound()
				if err := r.transfer(); err != nil {
					fail(err)
					return
				}
				for _, p := range r.peers {
					if !p.identity.Expires.IsZero() && !p.identity.Expires.After(now()) {
						r.remove(p, CloseRejected, ReasonAuthenticationExpired)
					} else if player := s.world.Find(p.id); player != nil && s.world.Expired(player) {
						r.remove(p, CloseRemoved, ReasonInputIdle)
					}
				}
				var snapshotTime *time.Duration
				if s.world.Tick%match.SnapshotEvery == 0 {
					s.updateInfo()
					captured := time.Now()
					if err := replica.Publish(wire.Capture(s.world)); err != nil {
						fail(err)
						return
					}
					cues := wire.CaptureCues(s.world)
					// A round change invalidates old visual cues, never required events.
					current := cues[:0]
					for _, cue := range cues {
						if cue.Round == s.world.Match.Round && replica.TimeMS()-cue.OccurredAtMS < 250 {
							current = append(current, cue)
						}
					}
					if err := replica.OfferCues(s.world.Match.Round, s.world.Tick, current, now()); err != nil {
						fail(err)
						return
					}
					s.world.DrainCues()
					elapsed := time.Since(captured)
					snapshotTime = &elapsed
					if s.trace.enabled.Load() {
						for _, p := range r.peers {
							s.trace.record(p.connection, now(), traceSample{Kind: "published", Tick: s.world.Tick, DurationMS: float64(elapsed.Nanoseconds()) / 1e6})
						}
					}
				}
				s.recordStep(time.Since(start), i > 0, snapshotTime)
			}
		}
		if err := r.pump(); err != nil {
			fail(err)
			return
		}
	}
}
