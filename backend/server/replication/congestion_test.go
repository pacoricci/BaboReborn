package replication

import (
	"testing"
	"time"
)

func TestStableHighRTTSustainsCadenceWithoutRepeatedRecovery(t *testing.T) {
	f := setup(t, nil)
	f.room.Pace(30)
	if err := f.room.Add(1, "slow-rtt", baseline(t, state(0, 0, 1))); err != nil {
		t.Fatal(err)
	}
	install := f.take(1, Installation)
	f.finish(1, install, false)
	f.now = f.now.Add(300 * time.Millisecond)
	if err := f.room.Acknowledge(1, install.Receipt); err != nil {
		t.Fatal(err)
	}
	type pending struct {
		packet *Packet
		at     time.Time
	}
	var queue []pending
	sent := 0
	for tick := 1; tick <= 90; tick++ {
		f.now = f.now.Add(time.Second / 30)
		for len(queue) > 0 && f.now.Sub(queue[0].at) >= 300*time.Millisecond {
			if err := f.room.Acknowledge(1, queue[0].packet.Receipt); err != nil {
				t.Fatal(err)
			}
			queue = queue[1:]
		}
		f.publish(tick, 0, 1)
		p, err := f.room.Next(1)
		if err != nil {
			t.Fatal(err)
		}
		if p != nil {
			f.finish(1, p, false)
			queue = append(queue, pending{p, f.now})
			sent++
		}
		if f.room.Recover(1) || f.usage(1).Closed != "" {
			t.Fatal(f.usage(1))
		}
	}
	if sent != 90 || f.usage(1).RateHz != 30 {
		t.Fatal(sent, f.usage(1))
	}
}

func TestOneSecondStallReducesRateAndRequiresRecoveryOnlyAfterProgress(t *testing.T) {
	f := setup(t, nil)
	f.room.Pace(30)
	f.join(1)
	f.join(2)
	f.publish(1, 0, 1)
	blocked := f.take(1, State)
	f.finish(1, blocked, false)
	for tick := 2; tick <= 31; tick++ {
		f.now = f.now.Add(time.Second / 30)
		f.publish(tick, 0, 1)
		f.room.Expire()
		p := f.take(2, State)
		f.finish(2, p, true)
	}
	if f.usage(1).Closed != "" || f.usage(1).RateHz != 10 || f.room.Recover(1) {
		t.Fatal(f.usage(1))
	}
	if err := f.room.Acknowledge(1, blocked.Receipt); err != nil {
		t.Fatal(err)
	}
	if !f.room.Recover(1) {
		t.Fatal("missing recovery after actual progress")
	}
	if err := f.room.Install(1, baseline(t, state(31, 0, 1))); err != nil {
		t.Fatal(err)
	}
	f.finish(1, f.take(1, Installation), true)
	if f.room.Recover(1) || !f.room.Ready(1, 2) || f.usage(2).RateHz != 30 {
		t.Fatal(f.usage(1), f.usage(2))
	}
}
