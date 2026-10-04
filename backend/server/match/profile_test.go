package match

import (
	"strings"
	"testing"
)

func TestDisplayNameValidationDoesNotMutateOnFailure(t *testing.T) {
	w := MustNew([]byte(`{"name":"test","schema":1,"theme":"classic","id":"test","author":"Tests","width":10,"height":10,"walls":[],"spawns":[{"x":2,"y":2}]}`))
	p := w.Add()
	if err := w.SelectNickname(p, "  Rolling_Babo-7  ", ""); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"", "   ", "<script>", "Babo\nPlayer", strings.Repeat("a", 21)} {
		if w.SelectNickname(p, invalid, "") == nil {
			t.Fatalf("accepted %q", invalid)
		}
		if p.Nickname != "Rolling_Babo-7" {
			t.Fatal("invalid selection changed profile")
		}
	}
	if p.ID != 1 || p.Status != "spectator" {
		t.Fatal("profile changed gameplay identity")
	}
}

func TestNicknameColorsAreValidatedAtomicallyAndCapturedInActivities(t *testing.T) {
	w := MustNew([]byte(`{"name":"test","schema":1,"theme":"classic","id":"test","author":"Tests","width":10,"height":10,"walls":[],"spawns":[{"x":2,"y":2}]}`))
	p := w.Add()
	if err := w.SelectNickname(p, "AB", "FF0000------"); err != nil {
		t.Fatal(err)
	}
	captured := participant(p)
	for _, colors := range []string{"ff0000", "#ff0000#0000ff", "xxxxxx------", strings.Repeat("ffffff", 21)} {
		if w.SelectNickname(p, "CD", colors) == nil {
			t.Fatalf("accepted %q", colors)
		}
		if p.Nickname != "AB" || p.NicknameColors != "ff0000------" {
			t.Fatal("invalid decoration changed profile")
		}
	}
	if err := w.SelectNickname(p, "CD", ""); err != nil {
		t.Fatal(err)
	}
	if p.NicknameColors != "" || captured.NicknameColors != "ff0000------" || captured.Nickname != "AB" {
		t.Fatal("reset changed captured identity")
	}
}
