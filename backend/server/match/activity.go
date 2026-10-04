package match

// Team is affiliation, independent of life status and cosmetic appearance.
// Deathmatch does not use affiliation to filter damage or award team scores.
type Team string

const (
	TeamNone Team = "none"
	TeamBlue Team = "blue"
	TeamRed  Team = "red"
)

type Participant struct {
	ID             int
	Nickname       string
	NicknameColors string
	Team           Team
}
type Activity struct {
	OccurredAtMS int64
	ID           int
	Tick         int
	Round        int
	Kind         string
	Actor        Participant
	Victim       *Participant
	Weapon       string
}

func participant(p *Player) Participant {
	return Participant{ID: p.ID, Nickname: p.Nickname, NicknameColors: p.NicknameColors, Team: p.Team}
}
func (w *World) activity(kind string, actor *Player, victim *Player, weapon string) {
	e := Activity{OccurredAtMS: w.TimeMS, Tick: w.Tick, Round: w.Match.Round, Kind: kind, Actor: participant(actor), Weapon: weapon}
	if victim != nil {
		v := participant(victim)
		e.Victim = &v
	}
	e.ID = w.event(Event{Kind: "activity", Activity: &e})
	w.Activities = append(w.Activities, e)
	// Bounded replay window; clients expire rows using the authority's event tick.
	if len(w.Activities) > 64 {
		w.Activities = w.Activities[len(w.Activities)-64:]
	}
}

func explosionWeapon(kind string) string {
	if kind == "rocket" {
		return "bazooka"
	}
	return kind
}
