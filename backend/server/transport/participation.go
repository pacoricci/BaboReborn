package transport

import (
	"strings"

	"baboreborn/backend/server/match"
)

func (i Identity) registered() bool {
	return strings.HasPrefix(i.Subject, "account:") && len(i.Subject) > len("account:")
}

// All retained participation belongs to this room's owner and current round.
func (r *roomRuntime) clearPreviousRound() {
	if r.retainedRound != r.s.world.Match.Round {
		r.retained = nil
		r.retainedRound = r.s.world.Match.Round
	}
}

func (r *roomRuntime) retain(p *peer) {
	r.clearPreviousRound()
	if !p.identity.registered() {
		return
	}
	if player := r.s.world.Find(p.id); player != nil {
		if r.retained == nil {
			r.retained = make(map[string]match.Standing)
		}
		r.retained[p.identity.Subject] = match.Standing{Team: player.Team, Score: player.Score, Kills: player.Kills, Deaths: player.Deaths}
	}
}

func (r *roomRuntime) register(p *peer) bool {
	r.clearPreviousRound()
	if !p.identity.Expires.IsZero() && !p.identity.Expires.After(r.now()) {
		return false
	}
	var previous *peer
	if p.identity.registered() {
		for _, candidate := range r.peers {
			if candidate.identity.Subject == p.identity.Subject {
				previous = candidate
				break
			}
		}
	}
	if previous == nil && len(r.s.world.Players) >= r.s.capacity {
		return false
	}
	if previous != nil {
		r.remove(previous, CloseRemoved, ReasonGameSessionReplaced)
	}
	player := r.s.world.Add()
	if p.identity.registered() {
		if saved, ok := r.retained[p.identity.Subject]; ok {
			player.Team, player.Score, player.Kills, player.Deaths = saved.Team, saved.Score, saved.Kills, saved.Deaths
			delete(r.retained, p.identity.Subject)
		}
	}
	p.id = player.ID
	r.peers[p.id] = p
	return true
}
