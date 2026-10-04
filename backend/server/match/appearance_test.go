package match

import (
	"reflect"
	"testing"
)

func TestAppearanceSelectionAndSpawn(t *testing.T) {
	for _, template := range []string{"geometric", "bands", "chevron", "diamonds", "hexagons", "triangles", "checkerboard", "rings", "starburst", "circuit", "hazard", "armor", "camo", "tiger", "fracture"} {
		t.Run(template, func(t *testing.T) {
			w, a, b := alivePair()
			w.ConfigureSkins(map[string]bool{"geometric": true, template: true}, "geometric")
			selected := Appearance{Template: template, Colors: []string{"#ffffff", "#234567", "#AA1234"}}
			if err := w.SelectAppearance(a, selected); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(a.Appearance, DefaultAppearance()) || !reflect.DeepEqual(b.NextAppearance, DefaultAppearance()) {
				t.Fatal("changed current life or another player")
			}
			selected.Colors[0] = "#000000"
			if a.NextAppearance.Colors[0] != "#ffffff" {
				t.Fatal("input alias")
			}
			a.Status = "dead"
			a.Died = w.Tick
			w.Tick += w.Rules.RespawnTicks
			if !w.Spawn(a) || a.Appearance.Template != template || a.Appearance.Colors[0] != "#ffffff" {
				t.Fatal("appearance not applied on spawn")
			}
			a.NextAppearance.Colors[0] = "#000000"
			if a.Appearance.Colors[0] != "#ffffff" {
				t.Fatal("current and next appearance alias")
			}
		})
	}
}
func TestInvalidAppearanceIsAtomic(t *testing.T) {
	w, a, _ := alivePair()
	for _, invalid := range []Appearance{
		{Template: "custom", Colors: []string{"#123456", "#123456", "#123456"}},
		{Template: "bands", Colors: []string{"#123456", "#123456"}},
		{Template: "bands", Colors: []string{"#123456", "#123456", "#123456", "#123456"}},
		{Template: "bands", Colors: []string{"red", "#fff", "#123456"}},
	} {
		if w.SelectAppearance(a, invalid) == nil {
			t.Fatal("accepted", invalid)
		}
		if !reflect.DeepEqual(a.NextAppearance, DefaultAppearance()) {
			t.Fatal("invalid selection changed state")
		}
	}
}
