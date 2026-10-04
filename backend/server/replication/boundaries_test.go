package replication

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"baboreborn/backend/server/wire"
)

func TestReceiptCannotRescueAnExpiredObligation(t *testing.T) {
	for _, required := range []bool{false, true} {
		f := setup(t, nil)
		f.join(1)
		kind, reason := State, DeliveryStalled
		if required {
			kind, reason = Control, ReliableTimeout
			if err := f.room.Notify(1, json.RawMessage(`{"notice":true}`)); err != nil {
				t.Fatal(err)
			}
		} else {
			f.publish(1, 0, 1)
		}
		p := f.take(1, kind)
		f.finish(1, p, false)
		f.now = f.now.Add(5 * time.Second)
		// No periodic expiry callback ran before this receipt.
		if err := f.room.Acknowledge(1, p.Receipt); !errors.Is(err, ErrPeer) || f.usage(1).Closed != reason {
			t.Fatal(err, f.usage(1))
		}
	}
}

func TestTransientExpiryRunsWhileWriterIsBlocked(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	f.publish(1, 0, 1)
	f.take(1, State)
	if err := f.room.OfferCues(1, 1, []wire.Cue{{ID: 1, Tick: 1, Round: 1, Kind: "explosion"}}, f.now); err != nil {
		t.Fatal(err)
	}
	if err := f.room.OfferProbe(1, json.RawMessage(`{"nonce":1}`), f.now); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(time.Second)
	f.room.Expire()
	if u := f.usage(1); u.PendingCues || u.WritingBytes == 0 || u.Closed != "" || f.room.peers[1].probe != nil {
		t.Fatal(u)
	}
}

func TestByteLimitedEventBatchesPreserveCoverageAcrossPrivateGaps(t *testing.T) {
	f := setup(t, func(l *Limits) { l.EventBatchBytes = 1024; l.EventBytes = 512 })
	f.join(1)
	f.join(2)
	var events []wire.Event
	for i := 1; i <= 19; i++ {
		owner := 1
		if i%2 == 0 {
			owner = 2
		}
		events = append(events, wire.Event{Kind: "hit", OwnerID: owner, Weapon: strings.Repeat("x", 150)})
	}
	f.append(1, events...)
	f.publish(1, 19, 1)
	f.finish(1, f.take(1, State), true)
	last, delivered, batches := 0, 0, 0
	for last < 19 {
		p := f.take(1, Events)
		b := body[wire.EventBatch](t, p)
		if len(p.Data) > 1024 || b.After != last || b.Through <= last {
			t.Fatal(len(p.Data), b)
		}
		for _, e := range b.Events {
			if e.ID != delivered*2+1 || e.OwnerID != 1 || e.ID > b.Through {
				t.Fatal(e)
			}
			delivered++
		}
		last = b.Through
		batches++
		f.finish(1, p, true)
	}
	if delivered != 10 || batches < 2 || f.usage(1).ReliableRecords != 0 || f.usage(2).ReliableRecords != 9 {
		t.Fatal(delivered, batches, f.usage(1), f.usage(2))
	}
}

func TestUnsendableEnvelopeFailsInsteadOfWaitingForeverForCredit(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	f.publish(1, 0, 1)
	f.room.encode = func(Envelope) ([]byte, error) { return make([]byte, (1<<20)+1), nil }
	if p, err := f.room.Next(1); p != nil || !errors.Is(err, ErrProducerLimit) || f.usage(1).Closed != ProducerOverload {
		t.Fatal(p, err, f.usage(1))
	}
}

func TestOldWriterCompletionCannotReleaseReplacementConnection(t *testing.T) {
	f := setup(t, nil)
	if err := f.room.Add(1, "old", baseline(t, state(0, 0, 1))); err != nil {
		t.Fatal(err)
	}
	old := f.take(1, Installation)
	f.room.Remove(1)
	if err := f.room.Add(1, "new", baseline(t, state(0, 0, 1))); err != nil {
		t.Fatal(err)
	}
	replacement := f.take(1, Installation)
	if err := f.room.Written(1, old.Receipt, nil); !errors.Is(err, ErrPublication) {
		t.Fatal(err)
	}
	if u := f.usage(1); u.WritingBytes != len(replacement.Data) || u.Closed != "" {
		t.Fatal(u)
	}
	f.finish(1, replacement, true)
}

func TestReleasedJournalSlotsDoNotConsumeRetentionBehindASlowPeer(t *testing.T) {
	f := setup(t, func(l *Limits) { l.JournalEvents = 4 })
	f.join(1)
	f.join(2)
	f.append(1, wire.Event{Kind: "hit", OwnerID: 1})
	retained := f.room.UsageRoom().JournalBytes
	for tick := 2; tick <= 100; tick++ {
		f.append(tick, wire.Event{Kind: "hit", OwnerID: 2})
		f.publish(tick, tick, 1)
		f.finish(2, f.take(2, State), true)
		f.finish(2, f.take(2, Events), true)
		u := f.room.UsageRoom()
		if u.JournalEvents != 1 || u.JournalBytes != retained || len(f.room.journal) > 4 || f.usage(1).Closed != "" {
			t.Fatal(u, f.usage(1))
		}
		for _, rec := range f.room.journal {
			if rec.waiting == 0 && rec.body != nil {
				t.Fatal("released payload retained behind an older obligation")
			}
		}
	}
}
