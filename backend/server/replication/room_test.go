package replication

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testwire"
	"baboreborn/backend/server/wire"
)

type fixture struct {
	room *Room
	now  time.Time
	t    *testing.T
}

func setup(t *testing.T, change func(*Limits)) *fixture {
	t.Helper()
	l := DefaultLimits()
	if change != nil {
		change(&l)
	}
	f := &fixture{now: time.Unix(1000, 0), t: t}
	r, err := New(l, func() time.Time { return f.now }, encodeTestEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	f.room = r
	return f
}
func state(tick, cut, round int) wire.Snapshot {
	return wire.Snapshot{Type: "snapshot", Version: gameconfig.ProtocolVersion, Tick: tick, EventCut: cut, Match: wire.Match{Round: round}}
}
func baseline(t *testing.T, s wire.Snapshot) Baseline {
	t.Helper()
	body, err := json.Marshal(struct {
		Type  string        `json:"type"`
		State wire.Snapshot `json:"state"`
	}{"install", s})
	if err != nil {
		t.Fatal(err)
	}
	return Baseline{State: s, Body: body}
}
func (f *fixture) join(id int) {
	f.t.Helper()
	if err := f.room.Add(id, fmt.Sprintf("connection-%d", id), baseline(f.t, state(0, f.room.cut, 1))); err != nil {
		f.t.Fatal(err)
	}
	p := f.take(id, Installation)
	f.finish(id, p, true)
}
func (f *fixture) take(id int, kind Kind) *Packet {
	f.t.Helper()
	p, err := f.room.Next(id)
	if err != nil || p == nil {
		f.t.Fatalf("next %s: %v, %+v", kind, err, p)
	}
	if p.Kind != kind {
		f.t.Fatalf("want %s, got %s", kind, p.Kind)
	}
	return p
}
func (f *fixture) finish(id int, p *Packet, ack bool) {
	f.t.Helper()
	if err := f.room.Written(id, p.Receipt, nil); err != nil {
		f.t.Fatal(err)
	}
	if ack {
		if err := f.room.Acknowledge(id, p.Receipt); err != nil {
			f.t.Fatal(err)
		}
	}
}
func (f *fixture) publish(tick, cut, round int) {
	f.t.Helper()
	if err := f.room.Publish(state(tick, cut, round)); err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) append(tick int, events ...wire.Event) {
	f.t.Helper()
	b := wire.EventBatch{Tick: tick, After: f.room.cut, Through: f.room.cut + len(events), Events: events}
	for i := range b.Events {
		b.Events[i].ID = b.After + i + 1
		b.Events[i].Tick = tick
		if b.Events[i].Round == 0 {
			b.Events[i].Round = 1
		}
	}
	if err := f.room.Append(b); err != nil {
		f.t.Fatal(err)
	}
}
func (f *fixture) usage(id int) Usage {
	f.t.Helper()
	u, err := f.room.Usage(id)
	if err != nil {
		f.t.Fatal(err)
	}
	return u
}
func body[T any](t *testing.T, p *Packet) T {
	t.Helper()
	var e struct {
		Body json.RawMessage `json:"body"`
	}
	var b T
	if err := testwire.Unmarshal(p.Data, &e); err != nil {
		t.Fatal(err)
	}
	expanded, err := testwire.Expand(e.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expanded, &b); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestBlockedWriterCoalescesStateAndKeepsRequiredFacts(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	f.join(2)
	f.publish(1, 0, 1)
	blocked := f.take(1, State)
	for tick := 2; tick <= 16; tick++ {
		f.now = f.now.Add(33 * time.Millisecond)
		f.append(tick, wire.Event{Kind: "damage", OwnerID: 1, Amount: 10, Weapon: "smg"})
		f.publish(tick, f.room.cut, 1)
		if p, err := f.room.Next(1); p != nil || err != nil {
			t.Fatal("second write while blocked", p, err)
		}
		// The healthy peer advances through the same authority without the blocked writer.
		for {
			p, err := f.room.Next(2)
			if err != nil {
				t.Fatal(err)
			}
			if p == nil {
				break
			}
			f.finish(2, p, true)
		}
	}
	if u := f.usage(1); !u.PendingState || u.ReplacedStates != 14 || u.ReliableRecords != 15 || u.Closed != "" {
		t.Fatal(u)
	}
	if u := f.usage(2); u.EventThrough != 15 || u.ReliableRecords != 0 {
		t.Fatal(u)
	}
	if f.room.UsageRoom().JournalEvents != 15 {
		t.Fatal("slow peer lost owed facts")
	}
	f.finish(1, blocked, false)
	latest := f.take(1, State)
	if s := body[wire.Snapshot](t, latest); s.Tick != 16 || s.EventCut != 15 {
		t.Fatal(s)
	}
	f.finish(1, latest, false)
	events := f.take(1, Events)
	b := body[wire.EventBatch](t, events)
	if b.After != 0 || b.Through != 15 || len(b.Events) != 15 {
		t.Fatal(b)
	}
	f.finish(1, events, false)
	if f.usage(1).OutstandingBytes == 0 || f.room.UsageRoom().JournalEvents != 15 {
		t.Fatal("write completion acknowledged data")
	}
	if err := f.room.Acknowledge(1, events.Receipt); err != nil {
		t.Fatal(err)
	}
	if u := f.usage(1); u.ReliableRecords != 0 || u.OutstandingBytes != 0 {
		t.Fatal(u)
	}
	if f.room.UsageRoom().JournalEvents != 0 {
		t.Fatal("acknowledged history retained")
	}
}

func TestWindowCreditBoundsBrowserBacklogAndReservesControls(t *testing.T) {
	f := setup(t, func(l *Limits) { l.WindowFrames = 5; l.ControlReserveFrames = 2 })
	f.join(1)
	for tick := 1; tick <= 3; tick++ {
		f.publish(tick, 0, 1)
		f.finish(1, f.take(1, State), false)
	}
	for tick := 4; tick <= 20; tick++ {
		f.publish(tick, 0, 1)
	}
	if p, err := f.room.Next(1); p != nil || err != nil {
		t.Fatal("credit overflow", p, err)
	}
	if err := f.room.Notify(1, json.RawMessage(`{"notice":"restart"}`)); err != nil {
		t.Fatal(err)
	}
	c := f.take(1, Control)
	f.finish(1, c, false)
	if err := f.room.OfferProbe(1, json.RawMessage(`{"nonce":1}`), f.now); err != nil {
		t.Fatal(err)
	}
	probe := f.take(1, Probe)
	f.finish(1, probe, false)
	if u := f.usage(1); u.OutstandingFrames != 5 || !u.PendingState {
		t.Fatal(u)
	}
	if err := f.room.Acknowledge(1, probe.Receipt); err != nil {
		t.Fatal(err)
	}
	if got := body[wire.Snapshot](t, f.take(1, State)); got.Tick != 20 {
		t.Fatal(got)
	}
}

func TestReceiptMatchesExactFrameWithoutSkippingEventCoverage(t *testing.T) {
	for _, bad := range []string{"future", "connection", "generation", "events"} {
		t.Run(bad, func(t *testing.T) {
			f := setup(t, nil)
			f.join(1)
			f.append(1, wire.Event{Kind: "hit", OwnerID: 1})
			f.publish(1, 1, 1)
			p := f.take(1, State)
			f.finish(1, p, false)
			a := p.Receipt
			switch bad {
			case "future":
				a.Sequence++
			case "connection":
				a.Connection = "previous socket"
			case "generation":
				a.Generation++
			case "events":
				a.EventThrough = 1
			}
			if f.room.Acknowledge(1, a) == nil || f.usage(1).Closed != InvalidReceipt {
				t.Fatal("accepted impossible receipt")
			}
		})
	}
	f := setup(t, nil)
	f.join(1)
	f.publish(1, 0, 1)
	p := f.take(1, State)
	// A receipt can race ahead of the owner's write-completion notification.
	if err := f.room.Acknowledge(1, p.Receipt); err != nil {
		t.Fatal(err)
	}
	if next, err := f.room.Next(1); next != nil || err != nil {
		t.Fatal("receipt released the busy writer")
	}
	f.finish(1, p, false)
	f.publish(2, 0, 1)
	f.finish(1, f.take(1, State), false)
	f.now = f.now.Add(4 * time.Second)
	if err := f.room.Acknowledge(1, p.Receipt); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(time.Second)
	f.room.Expire()
	if f.usage(1).Closed != DeliveryStalled {
		t.Fatal("duplicate receipt extended progress")
	}
}

func TestMapBarrierKeepsOldRoundEventsAndTheAcknowledgedCursor(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	f.append(1, wire.Event{Kind: "hit", OwnerID: 1})
	if err := f.room.Notify(1, json.RawMessage(`{"notice":"restart"}`)); err != nil {
		t.Fatal(err)
	}
	if err := f.room.Install(1, baseline(t, state(2, 1, 2))); err != nil {
		t.Fatal(err)
	}
	if err := f.room.Install(1, baseline(t, state(3, 1, 3))); !errors.Is(err, ErrInstallationPending) {
		t.Fatal(err)
	}
	f.publish(3, 1, 2)
	control := f.take(1, Control)
	f.finish(1, control, false)
	install := f.take(1, Installation)
	f.finish(1, install, false)
	if u := f.usage(1); u.EventThrough != 0 || u.Generation != 1 {
		t.Fatal("map cut jumped cursor", u)
	}
	if p, err := f.room.Next(1); p != nil || err != nil {
		t.Fatal("state crossed unacknowledged map barrier", p, err)
	}
	if err := f.room.Acknowledge(1, install.Receipt); err != nil {
		t.Fatal(err)
	}
	s := f.take(1, State)
	f.finish(1, s, true)
	e := f.take(1, Events)
	batch := body[wire.EventBatch](t, e)
	if batch.After != 0 || batch.Through != 1 || len(batch.Events) != 1 || batch.Events[0].Round != 1 {
		t.Fatal(batch)
	}
	if e.Receipt.Generation != 2 {
		t.Fatal("source epoch became installation generation")
	}
	f.finish(1, e, true)
}

func TestRecipientFilteringAndAdmissionDoNotReplayOrLeakPrivateHistory(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	f.append(1, wire.Event{Kind: "hit", OwnerID: 1})
	if err := f.room.Add(2, "new socket", baseline(t, state(1, 1, 1))); err != nil {
		t.Fatal(err)
	}
	f.finish(2, f.take(2, Installation), true)
	f.append(2, wire.Event{Kind: "signal", Signal: "pickup-health", OwnerID: 1}, wire.Event{Kind: "hit", OwnerID: 2}, wire.Event{Kind: "damage", OwnerID: 2})
	f.publish(2, 4, 1)
	for _, tc := range []struct {
		id, after int
		want      []int
	}{{1, 0, []int{1, 2, 4}}, {2, 1, []int{3, 4}}} {
		f.finish(tc.id, f.take(tc.id, State), true)
		p := f.take(tc.id, Events)
		b := body[wire.EventBatch](t, p)
		if b.After != tc.after || b.Through != 4 || len(b.Events) != len(tc.want) {
			t.Fatal(b)
		}
		for i, e := range b.Events {
			if e.ID != tc.want[i] {
				t.Fatal(b)
			}
		}
		f.finish(tc.id, p, true)
	}
	if f.room.UsageRoom().JournalEvents != 0 {
		t.Fatal("unowed history pinned journal")
	}
}

func TestRequiredDeadlineSurvivesProbeProgressAndMapChanges(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	f.append(1, wire.Event{Kind: "damage", OwnerID: 1})
	for i := 1; i <= 4; i++ {
		f.now = f.now.Add(time.Second)
		if err := f.room.OfferProbe(1, json.RawMessage(`{"nonce":1}`), f.now); err != nil {
			t.Fatal(err)
		}
		f.finish(1, f.take(1, Probe), true)
	}
	if err := f.room.Install(1, baseline(t, state(2, 1, 2))); err != nil {
		t.Fatal(err)
	}
	i := f.take(1, Installation)
	if want := time.Unix(1000, 0).Add(5 * time.Second); !i.Deadline.Equal(want) {
		t.Fatal("installation extended old deadline", i.Deadline)
	}
	f.finish(1, i, true)
	f.now = f.now.Add(time.Second)
	f.room.Expire()
	if f.usage(1).Closed != ReliableTimeout {
		t.Fatal(f.usage(1))
	}
}

func TestJournalPressureReleasesSlowPeerWithoutBlockingHealthyPeer(t *testing.T) {
	f := setup(t, func(l *Limits) { l.JournalEvents = 3 })
	f.join(1)
	f.join(2)
	for tick := 1; tick <= 4; tick++ {
		f.now = f.now.Add(30 * time.Millisecond)
		f.append(tick, wire.Event{Kind: "damage", OwnerID: 1})
		f.publish(tick, tick, 1)
		f.finish(2, f.take(2, State), true)
		f.finish(2, f.take(2, Events), true)
	}
	if f.usage(1).Closed != BacklogExceeded || f.usage(2).Closed != "" {
		t.Fatal(f.usage(1), f.usage(2))
	}
	if got := f.room.UsageRoom(); got.JournalBytes != 0 || got.JournalEvents != 0 {
		t.Fatal(got)
	}
	f.room.Remove(1)
	if err := f.room.Add(3, "replacement", baseline(t, state(4, 4, 1))); err != nil {
		t.Fatal(err)
	}
	f.finish(3, f.take(3, Installation), true)
	if f.usage(3).EventThrough != 4 {
		t.Fatal("reused slot inherited old obligations")
	}
}

func TestCuesAndProbesExpireAndCannotPrecedeTheirCheckpoint(t *testing.T) {
	f := setup(t, nil)
	f.join(1)
	cues := []wire.Cue{{ID: 1, Tick: 4, Round: 1, Kind: "explosion"}}
	if err := f.room.OfferCues(1, 4, cues, f.now); err != nil {
		t.Fatal(err)
	}
	if p, err := f.room.Next(1); p != nil || err != nil {
		t.Fatal("cue preceded state", p)
	}
	f.publish(4, 0, 1)
	f.finish(1, f.take(1, State), true)
	f.now = f.now.Add(250 * time.Millisecond)
	if p, err := f.room.Next(1); p != nil || err != nil || f.usage(1).PendingCues {
		t.Fatal("expired cue survived")
	}
	if err := f.room.OfferProbe(1, json.RawMessage(`{"nonce":1}`), f.now); err != nil {
		t.Fatal(err)
	}
	if err := f.room.OfferProbe(1, json.RawMessage(`{"nonce":2}`), f.now); err != nil {
		t.Fatal(err)
	}
	p := f.take(1, Probe)
	if b := body[map[string]int](t, p); b["nonce"] != 2 {
		t.Fatal(b)
	}
	f.finish(1, p, true)
	if err := f.room.OfferProbe(1, json.RawMessage(`{"nonce":3}`), f.now); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(time.Second)
	if p, err := f.room.Next(1); p != nil || err != nil {
		t.Fatal("expired probe survived")
	}
}

func TestBoundedBatchesDoNotStarveRecentStateOrRequiredEvents(t *testing.T) {
	f := setup(t, func(l *Limits) { l.EventBatchRecords = 2 })
	f.join(1)
	f.append(1, wire.Event{Kind: "damage"}, wire.Event{Kind: "damage"}, wire.Event{Kind: "damage"}, wire.Event{Kind: "damage"}, wire.Event{Kind: "damage"})
	f.publish(1, 5, 1)
	for i := 0; i < 6; i++ {
		if err := f.room.Notify(1, json.RawMessage(`{"notice":true}`)); err != nil {
			t.Fatal(err)
		}
	}
	var kinds []Kind
	last := 0
	for i := 0; i < 11; i++ {
		p, err := f.room.Next(1)
		if err != nil {
			t.Fatal(err)
		}
		if p == nil {
			break
		}
		kinds = append(kinds, p.Kind)
		if p.Kind == Events {
			b := body[wire.EventBatch](t, p)
			if b.After != last || len(b.Events) > 2 {
				t.Fatal(b)
			}
			last = b.Through
		}
		f.finish(1, p, true)
	}
	stateIndex := -1
	for i, kind := range kinds {
		if kind == State {
			stateIndex = i
			break
		}
	}
	if stateIndex < 0 || stateIndex > 2 || last != 5 {
		t.Fatal(kinds, last)
	}
}

func encodeTestEnvelope(e Envelope) ([]byte, error) {
	if e.Kind == State {
		return wire.EncodeStateDelivery(e.Connection, e.Sequence, e.Generation, e.EventThrough, e.SentAtMS, e.Body)
	}
	return json.Marshal(struct {
		Envelope
		Body json.RawMessage `json:"body"`
	}{e, json.RawMessage(e.Body)})
}
func binarySnapshot(t testing.TB, s wire.RecipientSnapshot) []byte {
	t.Helper()
	b, err := wire.EncodeSnapshot(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
