package wire

import (
	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/match"
)

type Event struct {
	OccurredAtMS int64     `json:"occurredAtMs"`
	ID           int       `json:"id"`
	Tick         int       `json:"tick"`
	Round        int       `json:"round"`
	Kind         string    `json:"kind"`
	OwnerID      int       `json:"ownerId"`
	Life         int       `json:"life"`
	SourceID     int       `json:"sourceId,omitempty"`
	Amount       float64   `json:"amount,omitempty"`
	Position     core.Vec3 `json:"position"`
	Action       int       `json:"action,omitempty"`
	Signal       string    `json:"signal,omitempty"`
	Phase        string    `json:"phase,omitempty"`
	Weapon       string    `json:"weapon,omitempty"`
	Activity     *Activity `json:"activity,omitempty"`
}

type Cue struct {
	OccurredAtMS int64     `json:"occurredAtMs"`
	ID           int       `json:"id"`
	Tick         int       `json:"tick"`
	Round        int       `json:"round"`
	Kind         string    `json:"kind"`
	OwnerID      int       `json:"ownerId"`
	Life         int       `json:"life"`
	Position     core.Vec3 `json:"position"`
	Radius       float64   `json:"radius,omitempty"`
	Shot         *Shot     `json:"shot,omitempty"`
}

type EventBatch struct {
	Type    string  `json:"type"`
	Version int     `json:"version"`
	Tick    int     `json:"tick"`
	After   int     `json:"after"`
	Through int     `json:"through"`
	Events  []Event `json:"events"`
	Cues    []Cue   `json:"cues"`
}

// Required facts are captured independently of cues, which accumulate until the
// next state capture. Neither function drains or aliases the authority buffers.
func CaptureRequiredEvents(w *match.World) EventBatch {
	out := EventBatch{Type: "events", Version: gameconfig.ProtocolVersion, Tick: w.Tick, After: w.EventFrom(), Through: w.EventCut(), Cues: []Cue{}}
	out.Events = make([]Event, 0, len(w.Events))
	for _, e := range w.Events {
		v := Event{OccurredAtMS: e.OccurredAtMS, ID: e.ID, Tick: e.Tick, Round: e.Round, Kind: e.Kind, OwnerID: e.Owner, Life: e.Life, SourceID: e.Source, Amount: e.Amount, Position: e.Position, Action: e.Action, Signal: e.Signal, Phase: e.Phase, Weapon: e.Weapon}
		if e.Activity != nil {
			a := activity(*e.Activity)
			v.Activity = &a
		}
		out.Events = append(out.Events, v)
	}
	return out
}

func CaptureCues(w *match.World) []Cue {
	out := make([]Cue, 0, len(w.Cues))
	for _, c := range w.Cues {
		out = append(out, Cue{OccurredAtMS: c.OccurredAtMS, ID: c.ID, Tick: c.Tick, Round: c.Round, Kind: c.Kind, OwnerID: c.Owner, Life: c.Life, Position: c.Position, Radius: c.Radius, Shot: shot(c.Shot)})
	}
	return out
}

func shot(s *core.Shot) *Shot {
	if s == nil {
		return nil
	}
	return &Shot{Surface: s.Surface, Kind: s.Kind, From: s.From, To: s.To, Killed: s.Killed, Pellets: project(s.Pellets, shot)}
}

// Recipient filtering is applied by the retained room journal.
func (e Event) AddressedTo(id int) bool {
	personal := e.Kind == "hit" || e.Kind == "signal" && (e.Signal == "pickup-health" || e.Signal == "pickup-equipment" || e.Signal == "pickup-grenade")
	return !personal || e.OwnerID == id
}
