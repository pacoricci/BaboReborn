package transport

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/core"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/internal/testwire"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

func TestSimulationClockCadenceAndBoundedRecovery(t *testing.T) {
	for _, tc := range []struct {
		name     string
		advances []time.Duration
		steps    []int
		dropped  []int64
	}{
		{"normal", []time.Duration{tickPeriod, tickPeriod, tickPeriod}, []int{1, 1, 1}, []int64{0, 0, 0}},
		{"fractions", []time.Duration{tickPeriod / 2, tickPeriod / 2, 1, tickPeriod - 1, 1}, []int{0, 0, 1, 0, 1}, []int64{0, 0, 0, 0, 0}},
		{"transient", []time.Duration{tickPeriod, 5 * tickPeriod, tickPeriod}, []int{1, 5, 1}, []int64{0, 0, 0}},
		{"long pause", []time.Duration{tickPeriod * 1200, 0, tickPeriod}, []int{8, 0, 1}, []int64{1192, 0, 0}},
		{"repeated overload", []time.Duration{tickPeriod * 30, tickPeriod * 12, tickPeriod * 9, tickPeriod}, []int{8, 8, 8, 1}, []int64{22, 4, 1, 0}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Unix(1000, 0)
			clock := simulationClock{last: now}
			var elapsed, accounted time.Duration
			for i, advance := range tc.advances {
				now = now.Add(advance)
				batch := clock.advance(now)
				if batch.steps != tc.steps[i] || batch.dropped != tc.dropped[i] || batch.elapsed != advance {
					t.Fatalf("wake %d: %+v", i, batch)
				}
				elapsed += advance
				accounted += (time.Duration(batch.steps) + time.Duration(batch.dropped)) * tickPeriod
				if elapsed != accounted+clock.remainder || clock.remainder < 0 || clock.remainder >= tickPeriod {
					t.Fatalf("lost time: elapsed=%s accounted=%s remainder=%s", elapsed, accounted, clock.remainder)
				}
			}
		})
	}
}

func TestSimulationClockIgnoresBackwardsTime(t *testing.T) {
	start := time.Unix(1000, 0)
	clock := simulationClock{last: start}
	if got := clock.advance(start.Add(-time.Second)); got != (clockBatch{}) {
		t.Fatal(got)
	}
	if got := clock.advance(start.Add(tickPeriod)); got.steps != 1 || got.elapsed != tickPeriod {
		t.Fatal("backwards sample moved the time origin", got)
	}
}

type controlledOwner struct {
	server *Server
	wakes  chan time.Time
	clock  atomic.Int64
	done   chan struct{}
	cancel context.CancelFunc
	ctx    context.Context
}

func startControlledOwner(t *testing.T, world *match.World) *controlledOwner {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	r := &controlledOwner{server: New(world, 16, nil), wakes: make(chan time.Time), done: make(chan struct{}), cancel: cancel, ctx: ctx}
	go func() {
		defer close(r.done)
		r.server.run(ctx, r.wakes, func() time.Time {
			return time.Unix(1000, 0).Add(time.Duration(r.clock.Load()))
		})
	}()
	t.Cleanup(func() {
		cancel()
		<-r.done
	})
	// A round trip through the owner proves its clock is initialized before time advances.
	if _, err := r.server.Apply(ctx, Administration{Action: ListParticipants}); err != nil {
		t.Fatalf("owner did not become ready: %v", err)
	}
	return r
}

func (r *controlledOwner) wake(t *testing.T, elapsed time.Duration, expectedSteps int) {
	t.Helper()
	before := r.server.Stats()
	r.clock.Add(int64(elapsed))
	select {
	case r.wakes <- time.Unix(1, 0): // Deliberately stale notification, never the consumed time.
	case <-r.ctx.Done():
		t.Fatal("owner stopped before wake")
	}
	for {
		stats := r.server.Stats()
		if stats.Wakes == before.Wakes+1 && stats.Ticks == before.Ticks+expectedSteps {
			return
		}
		select {
		case <-r.ctx.Done():
			t.Fatal("owner did not finish expected steps", stats)
		case <-time.After(time.Millisecond):
		}
	}
}

func TestOwnerUsesConsumedTimeAndReportsDroppedWallDebt(t *testing.T) {
	r := startControlledOwner(t, match.MustNew(testcontent.Map("yard")))
	r.wake(t, tickPeriod/2, 0)
	r.wake(t, tickPeriod-tickPeriod/2, 1)
	r.wake(t, tickPeriod*6, 6)
	r.wake(t, tickPeriod*30, 8)
	r.wake(t, tickPeriod*20, 8)
	r.wake(t, tickPeriod, 1)
	got := r.server.Stats()
	if got.Ticks != 24 || got.CatchUpTicks != 19 || got.DroppedWallTicks != 34 || got.OverloadWakes != 2 || got.LateTicks != 3 || got.Wakes != 6 {
		t.Fatalf("wrong wake accounting: %+v", got)
	}
	if math.Abs(got.ObservedWallSeconds-(tickPeriod*58).Seconds()) > 1e-12 || math.Abs(got.DroppedWallSeconds-(tickPeriod*34).Seconds()) > 1e-12 {
		t.Fatal("wall-time debt not reported separately", got.ObservedWallSeconds, got.DroppedWallSeconds)
	}
	if got.Snapshots != 6 || len(got.TickMicros) != 24 || len(got.SnapshotMicros) != 6 || len(got.WakeLagMicros) != 6 {
		t.Fatal("samples do not match executed work", got)
	}
	got.TickMicros[0], got.SnapshotMicros[0], got.WakeLagMicros[0] = -1, -1, -1
	owned := r.server.Stats()
	if owned.TickMicros[0] < 0 || owned.SnapshotMicros[0] < 0 || owned.WakeLagMicros[0] < 0 {
		t.Fatal("metrics leaked timing buffers")
	}
}

func TestOwnerStopsWhenWakeSourceCloses(t *testing.T) {
	r := startControlledOwner(t, match.MustNew(testcontent.Map("yard")))
	close(r.wakes)
	select {
	case <-r.done:
	case <-r.ctx.Done():
		t.Fatal("closed wake source did not stop the owner")
	}
	if r.server.Stats().Wakes != 0 {
		t.Fatal("closed channel became a wake")
	}
}

func TestCatchUpPreservesInputReleaseAndTimeout(t *testing.T) {
	for _, release := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "release"}[release], func(t *testing.T) {
			r := startControlledOwner(t, match.MustNew(testcontent.Map("yard")))
			p := &peer{connection: "controlled", cancel: func() {}}
			done := make(chan bool, 1)
			r.server.register <- registration{peer: p, done: done}
			if !<-done {
				t.Fatal("registration rejected")
			}
			take := func() *replication.Packet {
				v := r.server.deliver(r.ctx, deliveryRequest{peer: p})
				if v.err != nil {
					t.Fatal(v.err)
				}
				return v.packet
			}
			finish := func(packet *replication.Packet) {
				if v := r.server.deliver(r.ctx, deliveryRequest{peer: p, receipt: &packet.Receipt}); v.err != nil {
					t.Fatal(v.err)
				}
				r.server.incoming <- incoming{peer: p, message: Message{Type: "receipt", Receipt: &packet.Receipt}}
			}
			finish(take())
			r.server.incoming <- incoming{peer: p, message: Message{Type: "join", Generation: 1}}
			commands := make([]match.Command, 60)
			for i := range commands {
				commands[i] = match.Command{Seq: i + 1, Life: 1, Input: core.Input{X: 1, Aim: core.Vec2{X: 10, Y: 10}}}
			}
			for i := 0; i < len(commands); i += 15 {
				r.server.incoming <- incoming{peer: p, message: Message{Type: "input", Generation: 1, Inputs: commands[i : i+15]}}
			}
			if release {
				r.server.incoming <- incoming{peer: p, message: Message{Type: "release", Generation: 1}}
			}
			r.server.incoming <- incoming{peer: p, message: Message{Type: "ping"}}
			finish(take()) // Probe proves all preceding commands were handled.
			for i := 0; i < 4; i++ {
				r.wake(t, tickPeriod*8, 8)
			}
			packet := take()
			var frame struct {
				replication.Envelope
				Body json.RawMessage `json:"body"`
			}
			if err := testwire.Unmarshal(packet.Data, &frame); err != nil {
				t.Fatal(err)
			}
			var state wire.RecipientSnapshot
			if err := json.Unmarshal(frame.Body, &state); err != nil {
				t.Fatal(err)
			}
			if frame.Kind != replication.State || state.Tick != 32 || state.Local.Ack != 60 {
				t.Fatal(frame.Kind, state)
			}
			finish(packet)
		})
	}
}

func TestTimingBuffersRemainBoundedAndChronological(t *testing.T) {
	var samples []float64
	for i := 0; i < retainedTimingSamples+40; i++ {
		samples = timing(samples, time.Duration(i)*time.Microsecond)
	}
	if len(samples) != retainedTimingSamples || samples[0] != 40 || samples[len(samples)-1] != retainedTimingSamples+39 {
		t.Fatal("timing retention changed")
	}
}

type cancellingBrain struct{ cancel context.CancelFunc }

func (*cancellingBrain) Reset() {}
func (b *cancellingBrain) Decide(o bots.Observation, _ bots.Navigator) core.Input {
	b.cancel()
	return core.Input{Aim: core.Vec2{X: o.Self.X + 2, Y: o.Self.Y}}
}

func TestOwnerCancellationStopsWithinCatchUpBatch(t *testing.T) {
	world := match.MustNew(testcontent.Map("yard"))
	brain := &cancellingBrain{}
	if _, err := world.AddBot(brain, navigation.New(world.Geometry.Grid)); err != nil {
		t.Fatal(err)
	}
	r := startControlledOwner(t, world)
	brain.cancel = r.cancel // No wake or bot access until the channel send below.
	r.clock.Add(int64(tickPeriod * 30))
	r.wakes <- time.Unix(1, 0)
	<-r.done
	if got := r.server.Stats(); got.Ticks != 1 || got.CatchUpTicks != 0 || got.DroppedWallTicks != 22 {
		t.Fatal("cancelled owner completed the catch-up batch", got)
	}
}

func TestCatchUpPreservesMapSnapshotsAndEventDelivery(t *testing.T) {
	world := match.MustNew(testcontent.Map("yard"))
	yard, err := maps.Parse(testcontent.Map("yard"))
	if err != nil {
		t.Fatal(err)
	}
	crossing, err := maps.Parse(testcontent.Map("crossing"))
	if err != nil {
		t.Fatal(err)
	}
	if err := world.ConfigureRotation([]maps.Arena{yard, crossing}, nil); err != nil {
		t.Fatal(err)
	}
	world.Tick = 3
	rules := match.DefaultRules()
	rules.TimeLimitTicks, rules.EndTicks = 5, 2
	if err := world.Configure(rules); err != nil {
		t.Fatal(err)
	}
	world.Cues = []match.Cue{{ID: 21, Kind: "shot", Owner: 1, Tick: 3, Round: 1, Shot: &core.Shot{Kind: "smg"}}, {ID: 22, Kind: "explosion", Tick: 3, Round: 1}}

	r := startControlledOwner(t, world)
	httpServer := httptest.NewServer(r.server.Handler(r.ctx))
	defer httpServer.Close()
	c, _, err := dialAuthenticated(r.ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws?"+admissionQuery(compatibility.GameProfile()), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow() //nolint:errcheck // Test cleanup.
	var welcome map[string]any
	if err := readMessage(r.ctx, c, &welcome); err != nil || welcome["type"] != "welcome" {
		t.Fatal("missing welcome", err)
	}
	r.wake(t, tickPeriod*8, 8)
	var installation struct {
		Type  string
		Round int
		Arena maps.Arena
		State wire.Snapshot
	}
	if err := readMessage(r.ctx, c, &installation); err != nil {
		t.Fatal(err)
	}
	if installation.Type != "map" || installation.Round != 2 || installation.Arena.ID != "crossing" || installation.State.Tick != 11 {
		t.Fatal(installation)
	}
	var events wire.EventBatch
	if err := readMessage(r.ctx, c, &events); err != nil {
		t.Fatal(err)
	}
	if len(events.Events) != 2 || events.Events[0].Phase != "intermission" || events.Events[0].Round != 1 || events.Events[1].Phase != "playing" || events.Events[1].Round != 2 || len(events.Cues) != 0 {
		t.Fatal(events)
	}

	if stats := r.server.Stats(); stats.Snapshots != 2 || stats.CatchUpTicks != 7 || stats.Disconnects != 0 {
		t.Fatal(stats)
	}
}
