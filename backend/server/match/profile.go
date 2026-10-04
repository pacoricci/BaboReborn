package match

import (
	"errors"
	"regexp"
	"strings"
)

var nicknamePattern = regexp.MustCompile(`^[A-Za-z0-9 _-]{1,20}$`)

var nicknameColorsPattern = regexp.MustCompile(`^(?:[0-9a-f]{6}|------){1,20}$`)

// SelectNickname updates public display metadata without changing gameplay identity.
func (w *World) SelectNickname(p *Player, nickname string, colors string) error {
	nickname = strings.TrimSpace(nickname)
	if !nicknamePattern.MatchString(nickname) {
		return errors.New("invalid nickname")
	}
	colors = strings.ToLower(colors)
	if colors != "" && (len(colors) != 6*len(nickname) || !nicknameColorsPattern.MatchString(colors)) {
		return errors.New("invalid nickname colors")
	}
	p.NicknameColors = colors
	p.Nickname = nickname
	return nil
}
