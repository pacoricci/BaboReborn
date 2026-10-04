package maps

import (
	"encoding/json"
	"strings"
	"testing"

	"baboreborn/backend/internal/testcontent"
)

func TestThemeFileAndWireRoundTrip(t *testing.T) {
	for _, theme := range []string{"classic", "futuristic", "cyberpunk", "medieval"} {
		data := strings.Replace(string(testcontent.Map("yard")), `"theme": "classic"`, `"theme": "`+theme+`"`, 1)
		a, err := Parse([]byte(data))
		if err != nil || a.Theme != theme {
			t.Fatalf("theme %s: %v", theme, err)
		}
		wire, err := json.Marshal(a)
		if err != nil {
			t.Fatal(err)
		}
		b, err := Parse(wire)
		if err != nil || b.Theme != theme {
			t.Fatalf("lost theme: %v", err)
		}
	}
	for _, invalid := range []string{`null`, `""`, `12`, `"../texture.png"`} {
		data := strings.Replace(string(testcontent.Map("yard")), `"theme": "classic"`, `"theme":`+invalid, 1)
		if _, err := Parse([]byte(data)); err == nil {
			t.Fatalf("accepted theme %s", invalid)
		}
	}
}

func TestBundledMapsAndValidation(t *testing.T) {
	for _, data := range testcontent.Maps() {
		if _, err := Parse(data); err != nil {
			t.Fatal(err)
		}
	}
	cases := map[string]func(*Arena){
		"schema":     func(a *Arena) { a.Schema = 99 },
		"id":         func(a *Arena) { a.ID = "../map" },
		"width":      func(a *Arena) { a.Width = 129 },
		"fractional": func(a *Arena) { a.Height = 20.5 },
		"wall":       func(a *Arena) { a.Walls[0].W = 200 },
		"spawn-wall": func(a *Arena) { a.Spawns[0].X = 0 },
		"clearance":  func(a *Arena) { a.Spawns[0].X = 1.1 },
		"spawns":     func(a *Arena) { a.Spawns = nil },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			a, err := Parse(testcontent.Map("crossing"))
			if err != nil {
				t.Fatal(err)
			}
			change(&a)
			if a.Validate() == nil {
				t.Fatal("accepted invalid map")
			}
		})
	}
	for _, data := range []string{string(testcontent.Map("yard")) + " {}", strings.Replace(string(testcontent.Map("yard")), `"schema":`, `"unknown": 1,"schema":`, 1), strings.Repeat(" ", MaxBytes+1)} {
		if _, err := Parse([]byte(data)); err == nil {
			t.Fatal("accepted invalid file")
		}
	}
}
