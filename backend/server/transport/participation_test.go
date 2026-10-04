package transport

import (
	"errors"
	"testing"
	"time"

	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
)

func participationRuntime(t *testing.T) *roomRuntime {
	t.Helper()
	now := time.Now
	replica, err := replication.New(replication.DefaultLimits(), now, encodeDelivery)
	if err != nil {
		t.Fatal(err)
	}
	s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
	s.stats.DeliveryDisconnects = map[string]int{}
	return &roomRuntime{s: s, replica: replica, peers: map[int]*peer{}, now: now}
}
func participant(subject string) *peer {
	return &peer{identity: Identity{Subject: subject}, cancel: func() {}}
}
func TestParticipationRestoresOnlyRoundStatistics(t *testing.T) {
	for _, disconnected := range []bool{false, true} {
		t.Run(map[bool]string{false: "replacement", true: "disconnect"}[disconnected], func(t *testing.T) {
			r := participationRuntime(t)
			rules := match.DefaultRules()
			rules.Mode = match.ModeTDM
			if err := r.s.world.Configure(rules); err != nil {
				t.Fatal(err)
			}
			first := participant("account:one")
			r.register(first)
			player := r.s.world.Find(first.id)
			player.Score, player.Kills, player.Deaths, player.Team = 7, 9, 2, match.TeamRed
			player.Status, player.HP = "alive", 17
			player.State.X = 123
			r.register(participant("account:other")) // Replacement must work in a full room.
			if disconnected {
				r.remove(first, 0, "")
			}
			next := participant("account:one")
			if !r.register(next) {
				t.Fatal("rejoin refused")
			}
			got := r.s.world.Find(next.id)
			if got.Score != 7 || got.Kills != 9 || got.Deaths != 2 || got.Team != match.TeamRed {
				t.Fatalf("statistics lost: %+v", got)
			}
			if got.ID == first.id || got.Status != "spectator" || got.HP != 0 || got.State.X == 123 {
				t.Fatal("restored live state")
			}
			if err := r.receive(incoming{peer: first, err: errors.New("late EOF")}); err != nil {
				t.Fatal(err)
			}
			if r.s.world.Find(next.id) != got || len(r.peers) != 2 {
				t.Fatal("late close removed replacement")
			}
			if !r.s.world.Spawn(got) || got.Team != match.TeamRed || got.HP <= 17 || got.State.X == 123 {
				t.Fatal("normal spawn failed to preserve team or reset live state")
			}
			got.Score = 11
			r.remove(next, 0, "")
			last := participant("account:one")
			if !r.register(last) || r.s.world.Find(last.id).Score != 11 {
				t.Fatal("repeated rejoin restored stale statistics")
			}
		})
	}
}
func TestParticipationDoesNotCrossRoundAccountOrRoom(t *testing.T) {
	r := participationRuntime(t)
	p := participant("account:one")
	r.register(p)
	r.s.world.Find(p.id).Score = 12
	r.remove(p, 0, "")
	other := participant("account:other")
	r.register(other)
	if r.s.world.Find(other.id).Score != 0 {
		t.Fatal("another account inherited statistics")
	}
	r.s.world.Match.Round++
	next := participant("account:one")
	r.register(next)
	if r.s.world.Find(next.id).Score != 0 || len(r.retained) != 0 {
		t.Fatal("previous round retained")
	}
	fresh := participationRuntime(t)
	joined := participant("account:one")
	fresh.register(joined)
	if fresh.s.world.Find(joined.id).Score != 0 {
		t.Fatal("another room inherited statistics")
	}
}
func TestGuestsDoNotRestoreOrReplaceAndExpiredAdmissionKeepsPlayer(t *testing.T) {
	r := participationRuntime(t)
	guest := participant("guest:one")
	r.register(guest)
	r.s.world.Find(guest.id).Score = 8
	r.remove(guest, 0, "")
	next := participant("guest:one")
	r.register(next)
	if r.s.world.Find(next.id).Score != 0 {
		t.Fatal("guest restored")
	}
	another := participant("guest:one")
	if !r.register(another) || len(r.peers) != 2 {
		t.Fatal("guest replaced")
	}
	r = participationRuntime(t)
	current := participant("account:one")
	r.register(current)
	expired := participant("account:one")
	expired.identity.Expires = time.Now().Add(-time.Second)
	if r.register(expired) || r.s.world.Find(current.id) == nil {
		t.Fatal("expired admission replaced current player")
	}
}

func TestParticipationSavedDuringIntermissionExpiresAtRoundStart(t *testing.T) {
	r := participationRuntime(t)
	p := participant("account:one")
	r.register(p)
	player := r.s.world.Find(p.id)
	player.Score, player.Kills, player.Deaths, player.Team = 5, 6, 1, match.TeamBlue
	r.s.world.Match.Phase = "intermission"
	r.remove(p, 0, "")
	next := participant("account:one")
	r.register(next)
	if r.s.world.Find(next.id).Score != 5 {
		t.Fatal("same round lost statistics")
	}
	r.remove(next, 0, "")
	r.s.world.Match.Ends = r.s.world.Tick
	r.s.world.Step()
	r.clearPreviousRound()
	last := participant("account:one")
	r.register(last)
	got := r.s.world.Find(last.id)
	if got.Score != 0 || got.Kills != 0 || got.Deaths != 0 || got.Team != match.TeamNone {
		t.Fatal("ended round restored", got)
	}
}
