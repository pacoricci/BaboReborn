package match

import "baboreborn/backend/core"

// Events are accepted facts. Their buffers belong to the world owner until drained;
// snapshot replacement, presentation expiry and round reset cannot clear them.
type Event struct {
	OccurredAtMS          int64
	ID, Tick, Round       int
	Kind                  string
	Owner, Life, Source   int
	Amount                float64
	Position              core.Vec3
	Action                int
	Signal, Phase, Weapon string
	Activity              *Activity
}

// Cues describe finite presentation, independently of hit/damage confirmation.
type Cue struct {
	OccurredAtMS    int64
	ID, Tick, Round int
	Kind            string
	Owner, Life     int
	Position        core.Vec3
	Radius          float64
	Shot            *core.Shot
}

func (w *World) event(e Event) int {
	w.eventID++
	e.OccurredAtMS = w.TimeMS
	e.ID, e.Tick, e.Round = w.eventID, w.Tick, w.Match.Round
	if e.Life == 0 {
		if p := w.Find(e.Owner); p != nil {
			e.Life = p.Life
		}
	}
	w.Events = append(w.Events, e)
	return e.ID
}

func (w *World) cue(c Cue) int {
	w.cueID++
	c.OccurredAtMS = w.TimeMS
	c.ID, c.Tick, c.Round = w.cueID, w.Tick, w.Match.Round
	if c.Life == 0 {
		if p := w.Find(c.Owner); p != nil {
			c.Life = p.Life
		}
	}
	w.Cues = append(w.Cues, c)
	if len(w.Cues) > 160 {
		clear(w.Cues[:len(w.Cues)-160])
		w.Cues = w.Cues[len(w.Cues)-160:]
	}
	return c.ID
}

func shotHit(s *core.Shot) bool {
	if s == nil {
		return false
	}
	if s.Hit {
		return true
	}
	for _, pellet := range s.Pellets {
		if shotHit(pellet) {
			return true
		}
	}
	return false
}

func (w *World) EventCut() int  { return w.eventID }
func (w *World) EventFrom() int { return w.eventFrom }

// Call after detached capture, whether or not a state is being sent. A consumer
// must drain regularly; the simulation never silently truncates required facts.
func (w *World) DrainRequiredEvents() {
	clear(w.Events)
	w.Events = w.Events[:0]
	w.eventFrom = w.eventID
}
func (w *World) DrainCues()   { clear(w.Cues); w.Cues = w.Cues[:0] }
func (w *World) DrainEvents() { w.DrainRequiredEvents(); w.DrainCues() }
