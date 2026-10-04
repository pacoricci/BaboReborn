package replication

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"baboreborn/backend/server/wire"
)

func TestBudgetAccountsEncodedBytesAndReleasesOnlyCoveredCredit(t *testing.T) {
	f := setup(t, func(l *Limits) { l.WindowBytes = 3 << 20; l.ControlReserveBytes = 2 << 20 })
	f.join(1)
	// Headers are part of the committed wire cost, not just the body estimate.
	f.room.encode = func(e Envelope) ([]byte, error) {
		b, err := encodeTestEnvelope(e)
		return append(b, []byte(strings.Repeat("x", 400<<10))...), err
	}
	var sent []*Packet
	total := 0
	for tick := 1; tick <= 3; tick++ {
		f.publish(tick, 0, 1)
		p, err := f.room.Next(1)
		if err != nil {
			t.Fatal(err)
		}
		if p != nil {
			sent = append(sent, p)
			total += len(p.Data)
			f.finish(1, p, false)
		}
	}
	if len(sent) != 2 {
		t.Fatal("wire headers escaped the byte limit", len(sent))
	}
	if u := f.usage(1); u.OutstandingBytes != total || !u.PendingState {
		t.Fatal(u)
	}
	if err := f.room.Acknowledge(1, sent[0].Receipt); err != nil {
		t.Fatal(err)
	}
	if u := f.usage(1); u.OutstandingBytes != len(sent[1].Data) || u.OutstandingFrames != 1 {
		t.Fatal(u)
	}
	if p, err := f.room.Next(1); p == nil || err != nil {
		t.Fatal("ack did not restore exact credit", err)
	}
}

func TestControlsAndPerRecipientRecordsHaveIndependentHardLimits(t *testing.T) {
	for _, kind := range []string{"controls", "records", "bytes"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t, func(l *Limits) {
				if kind == "controls" {
					l.Controls = 2
				}
				if kind == "records" {
					l.ReliableRecords = 2
				}
			})
			f.join(1)
			f.join(2)
			switch kind {
			case "controls":
				for i := 0; i < 3; i++ {
					if err := f.room.Notify(1, json.RawMessage(`{"notice":true}`)); err != nil && !errors.Is(err, ErrPeer) {
						t.Fatal(err)
					}
				}
			case "records":
				f.append(1, wire.Event{Kind: "hit", OwnerID: 1}, wire.Event{Kind: "hit", OwnerID: 1}, wire.Event{Kind: "hit", OwnerID: 1})
			case "bytes":
				payload := json.RawMessage(`{"notice":"` + strings.Repeat("x", (2<<20)-20) + `"}`)
				for i := 0; i < 4; i++ {
					if err := f.room.Notify(1, payload); err != nil && !errors.Is(err, ErrPeer) {
						t.Fatal(err)
					}
				}
			}
			if u := f.usage(1); u.Closed != BacklogExceeded || u.ReliableBytes != 0 || u.ReliableRecords != 0 {
				t.Fatal(u)
			}
			if f.usage(2).Closed != "" {
				t.Fatal("unaddressed peer suffered overflow")
			}
			if f.room.UsageRoom().JournalBytes != 0 {
				t.Fatal("closed peer pinned event payloads")
			}
		})
	}
}

func TestInvalidAndOversizedProducerBatchesAreAtomic(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	valid := wire.Event{ID: 1, Tick: 1, Round: 1, Kind: "damage", OwnerID: 1}
	for _, b := range []wire.EventBatch{
		{After: 1, Through: 2, Tick: 1, Events: []wire.Event{valid}},
		{After: 0, Through: 2, Tick: 1, Events: []wire.Event{valid}},
		{After: 0, Through: 2, Tick: 1, Events: []wire.Event{valid, valid}},
		{After: 0, Through: 1, Tick: 0, Events: []wire.Event{valid}},
	} {
		if !errors.Is(f.room.Append(b), ErrPublication) {
			t.Fatal("accepted malformed stream", b)
		}
	}
	large := valid
	large.Weapon = strings.Repeat("x", f.room.limits.EventBytes)
	if !errors.Is(f.room.Append(wire.EventBatch{After: 0, Through: 1, Tick: 1, Events: []wire.Event{large}}), ErrProducerLimit) {
		t.Fatal("accepted oversized event")
	}
	if f.room.cut != 0 || f.usage(1).ReliableRecords != 0 || f.room.UsageRoom().JournalBytes != 0 {
		t.Fatal("rejected publication partially changed room")
	}
	f.append(1, wire.Event{Kind: "hit", OwnerID: 1})
}

func TestEnvelopeFailureIsExplicitAndDoesNotPretendToDeliver(t *testing.T) {
	for _, fail := range []string{"encode", "size"} {
		t.Run(fail, func(t *testing.T) {
			f := setup(t, nil)
			f.join(1)
			f.publish(1, 0, 1)
			f.room.encode = func(Envelope) ([]byte, error) {
				if fail == "encode" {
					return nil, errors.New("encode failed")
				}
				return make([]byte, f.room.limits.FrameBytes+1), nil
			}
			if packet, err := f.room.Next(1); packet != nil || err == nil {
				t.Fatal(packet, err)
			}
			u := f.usage(1)
			if u.Closed == "" || u.Sequence != 1 || u.OutstandingFrames != 0 {
				t.Fatal(u)
			}
		})
	}
}

func TestCapturePayloadsCannotBeMutatedAfterTransfer(t *testing.T) {
	f := setup(t, nil)
	b := baseline(t, state(0, 0, 1))
	if err := f.room.Add(1, "one", b); err != nil {
		t.Fatal(err)
	}
	clear(b.Body)
	p := f.take(1, Installation)
	if !json.Valid(p.Data) {
		t.Fatal("installation aliased producer memory")
	}
	f.finish(1, p, true)
	activity := &wire.Activity{ID: 1, Tick: 1, Round: 1, Kind: "connected", Actor: wire.Participant{Nickname: "Original"}}
	f.append(1, wire.Event{Kind: "activity", Activity: activity})
	activity.Actor.Nickname = "Mutated"
	s := state(1, 1, 1)
	s.Players = []wire.Player{{ID: 1, Nickname: "Original"}}
	if err := f.room.Publish(s); err != nil {
		t.Fatal(err)
	}
	s.Players[0].Nickname = "Mutated"
	p = f.take(1, State)
	if b := body[wire.Snapshot](t, p); b.Players[0].Nickname != "Original" {
		t.Fatal(b)
	}
	f.finish(1, p, true)
	p = f.take(1, Events)
	if b := body[wire.EventBatch](t, p); b.Events[0].Activity.Actor.Nickname != "Original" {
		t.Fatal(b)
	}
	f.finish(1, p, true)
	// All vacated journal slots must release their references, including the backing array.
	for _, rec := range f.room.journal[:cap(f.room.journal)] {
		if rec.body != nil {
			t.Fatal("acknowledged payload retained outside journal length")
		}
	}
}

func TestWriteDeadlineClosesWithTheUnderlyingDeliveryCause(t *testing.T) {
	for _, required := range []bool{false, true} {
		f := setup(t, nil)
		f.join(1)
		if required {
			if err := f.room.Notify(1, json.RawMessage(`{"notice":true}`)); err != nil && !errors.Is(err, ErrPeer) {
				t.Fatal(err)
			}
		} else {
			f.publish(1, 0, 1)
		}
		kind, want := State, DeliveryStalled
		if required {
			kind, want = Control, ReliableTimeout
		}
		p := f.take(1, kind)
		f.now = f.now.Add(5 * time.Second)
		if f.room.Written(1, p.Receipt, errors.New("deadline")) == nil {
			t.Fatal("write deadline ignored")
		}
		if u := f.usage(1); u.Closed != want || u.WritingBytes != 0 {
			t.Fatal(u)
		}
	}
}
