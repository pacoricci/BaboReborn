package match

import (
	"errors"
	"regexp"
)

type Appearance struct {
	Template string
	Colors   []string
}

var skinColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func DefaultAppearance() Appearance {
	return Appearance{Template: "geometric", Colors: []string{"#235cce", "#162c61", "#e8eef5"}}
}
func (w *World) SelectAppearance(p *Player, a Appearance) error {
	if !w.skinIDs[a.Template] {
		return errors.New("invalid appearance")
	}
	if len(a.Colors) != 3 {
		return errors.New("invalid appearance")
	}
	for _, c := range a.Colors {
		if !skinColor.MatchString(c) {
			return errors.New("invalid skin color")
		}
	}
	p.NextAppearance = Appearance{Template: a.Template, Colors: append([]string(nil), a.Colors...)}
	return nil
}

// ConfigureSkins copies catalog values so callers cannot change live validation.
func (w *World) ConfigureSkins(ids map[string]bool, defaultID string) {
	w.skinIDs = map[string]bool{}
	for id, ok := range ids {
		if ok {
			w.skinIDs[id] = true
		}
	}
	w.defaultSkin = defaultID
}
