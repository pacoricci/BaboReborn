package maps

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"baboreborn/backend/internal/testcontent"
)

func TestSharedDecalValidationAndVersionedRoundTrip(t *testing.T) {
	data, err := os.ReadFile("../../content/decal-validation.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Patch  map[string]any
		Remove []string
		Valid  bool
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		var arena map[string]any
		if err := json.Unmarshal(testcontent.Map("ion-foundry"), &arena); err != nil {
			t.Fatal(err)
		}
		decal := map[string]any{"asset": "oil", "x": 8, "y": 8, "w": 2, "h": 2, "angle": 0, "opacity": 0.6}
		for k, v := range c.Patch {
			decal[k] = v
		}
		for _, k := range c.Remove {
			delete(decal, k)
		}
		arena["decals"] = []any{decal}
		raw, err := json.Marshal(arena)
		if err != nil {
			t.Fatal(err)
		}
		_, err = Parse(raw)
		if (err == nil) != c.Valid {
			t.Fatalf("case %d: valid=%v, err=%v", i, c.Valid, err)
		}
	}
	a, err := Parse(testcontent.Map("ion-foundry"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Parse(raw)
	if err != nil || !reflect.DeepEqual(a, b) {
		t.Fatalf("decal round trip: %v", err)
	}
	for _, version := range []int{0, SchemaVersion + 1} {
		a.Schema = version
		if a.Validate() == nil {
			t.Fatalf("unsupported schema %d accepted", version)
		}
	}
	a.Schema = SchemaVersion
	a.Decals = make([]Decal, MaxDecals+1)
	if a.Validate() == nil {
		t.Fatal("unbounded decals accepted")
	}
	a.Decals = nil
	if a.Validate() != nil {
		t.Fatal("undecorated map rejected")
	}
}
