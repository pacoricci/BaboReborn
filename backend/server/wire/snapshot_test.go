package wire_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"runtime"
	"testing"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/wire"
)

// Fixtures exercise both independent capture paths in one versioned body.
func captureEventFixture(w *match.World) wire.EventBatch {
	out := wire.CaptureRequiredEvents(w)
	out.Cues = wire.CaptureCues(w)
	return out
}

func snapshotFixtureWorld() *match.World {
	w := snapshotWorkload()
	w.Players = w.Players[:2]
	w.Items = w.Items[:1]
	w.Projectiles = w.Projectiles[3:5]
	w.Cues = w.Cues[:4]
	w.Activities = w.Activities[:4]
	return w
}
func freeze(w *match.World) {
	w.Match.Phase = "intermission"
	w.Match.Ends = 100
	w.Match.Ranking = []match.Standing{{Team: match.TeamNone, ID: 2, Score: 9, Kills: 10, Deaths: 1}, {Team: match.TeamNone, ID: 1, Score: 0, Kills: 1, Deaths: 1}}
}
func jsonBytes(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestSnapshotContract(t *testing.T) {
	for _, name := range []string{"playing", "intermission", "empty"} {
		t.Run(name, func(t *testing.T) {
			w := snapshotFixtureWorld()
			if name == "intermission" {
				freeze(w)
				w.Remove(2)
			}
			if name == "empty" {
				w = match.MustNew([]byte(`{"name":"Empty","schema":1,"theme":"classic","id":"synthetic","author":"Tests","width":36,"height":36,"walls":[],"spawns":[{"x":4,"y":4}]}`))
			}
			// State and event bodies form one versioned contract.
			actual := jsonBytes(t, struct {
				State  wire.RecipientSnapshot `json:"state"`
				Events wire.EventBatch        `json:"events"`
			}{wire.Capture(w).ForRecipient(1), captureEventFixture(w)})
			path := fmt.Sprintf("testdata/v%d-%s.json", gameconfig.ProtocolVersion, name)
			if os.Getenv("UPDATE_PROTOCOL_FIXTURES") == "1" {
				if err := os.WriteFile(path, actual, 0600); err != nil {
					t.Fatal(err)
				}
			}
			expected, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var compact bytes.Buffer
			if err := json.Compact(&compact, expected); err != nil {
				t.Fatal(err)
			}

			if !bytes.Equal(actual, compact.Bytes()) {
				t.Fatalf("snapshot contract changed\nwant %s\ngot  %s", compact.Bytes(), actual)
			}
		})
	}
}

func TestCaptureOmitsUnusedFieldsAndPhotonSegmentsWithoutChangingAuthority(t *testing.T) {
	w := snapshotWorkload()
	w.Projectiles = append(w.Projectiles, &match.Projectile{ID: 999, Kind: "photon"})
	before := wire.Capture(w)
	if len(before.Projectiles) != len(w.Projectiles)-1 || w.Projectiles[len(w.Projectiles)-1].Kind != "photon" {
		t.Fatal("Photon filtering changed authority or included a hidden segment")
	}
	for i, p := range w.Players {
		if before.Players[i].State != p.State {
			t.Fatal("prediction checkpoint changed")
		}
		p.NextPrimary, p.NextSecondary = "sniper", "minibot"
		p.NextAppearance.Colors = []string{"#000000", "#111111", "#222222"}
	}
	for i, item := range w.Items {
		if before.Items[i].ID != item.ID || before.Items[i].Position != item.Position {
			t.Fatal("pickup identity or exact flight position changed")
		}
	}
	if !bytes.Equal(jsonBytes(t, before), jsonBytes(t, wire.Capture(w))) {
		t.Fatal("unused metadata changed snapshot bytes")
	}
	cues := wire.CaptureCues(w)
	for _, cue := range cues {
		if cue.Shot != nil && cue.Shot.Kind == "photon" {
			return
		}
	}
	t.Fatal("Photon beam cue was lost")
}

func TestCapturedSnapshotSurvivesAuthorityChanges(t *testing.T) {
	cases := map[string]func(*testing.T, *match.World){
		"all visible fields": func(t *testing.T, w *match.World) {
			for _, v := range []any{&w.Flags, &w.Players, &w.Items, &w.Projectiles, &w.Events, &w.Cues, &w.Activities, &w.Match, &w.Rules} {
				change(reflect.ValueOf(v).Elem())
			}
		},
		"advance and removal": func(t *testing.T, w *match.World) {
			for range 150 {
				w.Step()
			}
			w.Remove(w.Players[0].ID)
		},
		"drain and reuse buffers": func(t *testing.T, w *match.World) {
			w.Events = w.Events[:0]
			w.Events = append(w.Events, match.Event{ID: 999})
			w.Cues = w.Cues[:0]
			w.Cues = append(w.Cues, match.Cue{ID: 999})
			w.Activities = w.Activities[:0]
			w.Activities = append(w.Activities, match.Activity{ID: 999})
		},
		"frozen ranking": func(t *testing.T, w *match.World) {
			w.Match.Ranking[0].Score = 999
			w.Match.Ranking[0], w.Match.Ranking[1] = w.Match.Ranking[1], w.Match.Ranking[0]
			w.Remove(2)
		},
		"round and map reset": func(t *testing.T, w *match.World) {
			w.Match.Ends = w.Tick
			w.Step()
			if w.Match.Round != 2 || w.Arena.ID != "next" {
				t.Fatal("fixture did not cross the map boundary")
			}
			w.Add()
			w.Events = append(w.Events, match.Event{ID: 999})
			w.Items = append(w.Items, &match.Item{ID: 999})
			w.Projectiles = append(w.Projectiles, &match.Projectile{ID: 999})
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			w := snapshotFixtureWorld()
			if name == "round and map reset" {
				w = match.MustNew(jsonBytes(t, w.Arena))
				next := w.Arena
				next.ID, next.Name = "next", "Next map"
				if err := w.ConfigureRotation([]maps.Arena{w.Arena, next}, nil); err != nil {
					t.Fatal(err)
				}
				w.Spawn(w.Add())
				w.Spawn(w.Add())
			}
			if name == "frozen ranking" || name == "round and map reset" {
				freeze(w)
			}
			snapshot := wire.Capture(w)
			before := jsonBytes(t, snapshot)
			mutate(t, w)
			if after := jsonBytes(t, snapshot); !bytes.Equal(before, after) {
				t.Fatal("retained snapshot changed with authority")
			}
		})
	}
}

func TestSnapshotExcludesActivityHistoryAndInstallationCaptureOwnsIt(t *testing.T) {
	w := snapshotFixtureWorld()
	snapshot := jsonBytes(t, wire.Capture(w))
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(snapshot, &fields); err != nil {
		t.Fatal(err)
	}
	if _, exists := fields["activities"]; exists {
		t.Fatal("ordinary snapshot contains activity history")
	}
	history := wire.CaptureActivities(w)
	before := jsonBytes(t, history)
	if len(history) != len(w.Activities) || history[0].Victim == nil {
		t.Fatal("missing installation history")
	}
	w.Activities[0].Actor.Nickname = "Changed"
	w.Activities[0].Victim.Nickname = "Changed victim"
	w.Activities = append(w.Activities, match.Activity{ID: 999})
	if !bytes.Equal(before, jsonBytes(t, history)) {
		t.Fatal("installation history aliases authority")
	}
	if !bytes.Equal(snapshot, jsonBytes(t, wire.Capture(w))) {
		t.Fatal("activity history changed ordinary snapshot bytes")
	}
	w.Activities = []match.Activity{}
	if got := wire.CaptureActivities(w); got == nil || len(got) != 0 {
		t.Fatal("empty installation history must encode as []")
	}
}

func TestCapturedEventsAndCuesAreOwned(t *testing.T) {
	w := snapshotFixtureWorld()
	out := captureEventFixture(w)
	before := jsonBytes(t, out)
	change(reflect.ValueOf(&w.Events).Elem())
	change(reflect.ValueOf(&w.Cues).Elem())
	w.DrainEvents()
	if !bytes.Equal(before, jsonBytes(t, out)) {
		t.Fatal("events alias mutable authority")
	}
}

// Exercise every reachable reference, including future nested DTO fields, without
// depending on a hand-maintained list of values to mutate.
func change(v reflect.Value) {
	if v.Kind() == reflect.Pointer {
		if !v.IsNil() {
			change(v.Elem())
		}
		return
	}
	switch v.Kind() {
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Field(i).CanSet() {
				change(v.Field(i))
			}
		}
	case reflect.Slice:
		for i := range v.Len() {
			change(v.Index(i))
		}
	case reflect.String:
		v.SetString(v.String() + " changed")
	case reflect.Bool:
		v.SetBool(!v.Bool())
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(v.Int() + 1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(v.Uint() + 1)
	case reflect.Float32, reflect.Float64:
		v.SetFloat(v.Float() + 1)
	}
}

func TestConsumerMutationCannotChangeAuthorityOrAnotherCapture(t *testing.T) {
	w := snapshotFixtureWorld()
	freeze(w)
	snapshot := wire.Capture(w)
	independent := wire.Capture(w)
	before := jsonBytes(t, independent)
	change(reflect.ValueOf(&snapshot).Elem())
	if bytes.Equal(before, jsonBytes(t, snapshot)) {
		t.Fatal("fixture mutation did not change the snapshot")
	}
	if !bytes.Equal(before, jsonBytes(t, wire.Capture(w))) || !bytes.Equal(before, jsonBytes(t, independent)) {
		t.Fatal("consumer mutation crossed capture ownership")
	}
}

func TestCapturedSnapshotCanSerializeWhileOwnerAdvances(t *testing.T) {
	type sample struct {
		snapshot wire.Snapshot
		expected []byte
	}
	samples := make(chan sample, 8)
	done := make(chan error, 1)
	go func() {
		var failure error
		for s := range samples {
			runtime.Gosched()
			for range 2 {
				data, err := json.Marshal(s.snapshot)
				if err != nil {
					failure = err
				} else if !bytes.Equal(data, s.expected) {
					failure = fmt.Errorf("tick %d changed after capture", s.snapshot.Tick)
				}
			}
		}
		done <- failure
	}()
	w := snapshotWorkload()
	for tick := range 256 {
		snapshot := wire.Capture(w)
		samples <- sample{snapshot: snapshot, expected: jsonBytes(t, snapshot)}
		w.Step()
		w.Players[0].Appearance.Colors[0] = fmt.Sprintf("#%06x", tick)
		// Reuse authority buffers before the asynchronous consumer has finished.
		w.Events = w.Events[:0]
		w.Cues = w.Cues[:0]
		target := w.Players[1].ID
		w.Cues = append(w.Cues, match.Cue{ID: 1000 + tick, Owner: 1, Shot: &core.Shot{TargetID: &target, Pellets: []*core.Shot{{TargetID: &target}}}})
	}
	close(samples)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestCapturePreservesNilEmptyAndOptionalFields(t *testing.T) {
	w := snapshotFixtureWorld()
	w.Cues = []match.Cue{{ID: 1, Shot: nil}, {ID: 2, Shot: &core.Shot{Pellets: []*core.Shot{nil}}}}
	events := captureEventFixture(w)
	if events.Cues[0].Shot != nil || events.Cues[1].Shot.Pellets[0] != nil {
		t.Fatal("nil cue fields changed")
	}
	w.Players, w.Items, w.Projectiles, w.Activities = nil, nil, nil, nil
	w.Match.Phase = "intermission"
	w.Match.Ranking = nil
	s := wire.Capture(w)
	if s.Players != nil || s.Items != nil || s.Projectiles != nil || wire.CaptureActivities(w) != nil || s.Match.Ranking != nil {
		t.Fatal("nil became empty")
	}
}

func TestSnapshotDataBoundaryAndValueCheckpoint(t *testing.T) {
	allowedCore := map[reflect.Type]bool{reflect.TypeFor[core.Player](): true, reflect.TypeFor[core.Equipment](): true, reflect.TypeFor[core.Vec3](): true}
	seen := map[reflect.Type]bool{}
	var check func(reflect.Type)
	check = func(typ reflect.Type) {
		if seen[typ] {
			return
		}
		seen[typ] = true
		if path := typ.PkgPath(); path != "" && path != "baboreborn/backend/server/wire" && path != "baboreborn/backend/core" {
			t.Fatalf("snapshot depends on domain type %s", typ)
		}
		if typ.PkgPath() == "baboreborn/backend/core" && !allowedCore[typ] {
			t.Fatalf("unreviewed core wire contract: %s", typ)
		}
		switch typ.Kind() {
		case reflect.Pointer, reflect.Slice:
			check(typ.Elem())
		case reflect.Struct:
			for i := range typ.NumField() {
				field := typ.Field(i)
				if field.Anonymous || field.Tag.Get("json") == "" {
					t.Fatalf("implicit wire field %s.%s", typ, field.Name)
				}
				check(field.Type)
			}
		}
	}
	check(reflect.TypeFor[wire.Snapshot]())
	check(reflect.TypeFor[wire.EventBatch]())
	var valueOnly func(reflect.Type)
	valueOnly = func(typ reflect.Type) {
		switch typ.Kind() {
		case reflect.Struct:
			for i := range typ.NumField() {
				valueOnly(typ.Field(i).Type)
			}
		case reflect.Array:
			valueOnly(typ.Elem())
		case reflect.Bool, reflect.String, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		default:
			t.Fatalf("shared checkpoint gained mutable references: %s", typ)
		}
	}
	valueOnly(reflect.TypeFor[core.Player]())
	valueOnly(reflect.TypeFor[core.Vec3]())
	for _, typ := range []reflect.Type{reflect.TypeFor[match.Player](), reflect.TypeFor[match.Item](), reflect.TypeFor[match.Projectile](), reflect.TypeFor[match.Event](), reflect.TypeFor[match.Activity](), reflect.TypeFor[match.Match]()} {
		for i := range typ.NumField() {
			if typ.Field(i).Tag.Get("json") != "" {
				t.Fatalf("mutable authority record owns wire tags: %s", typ)
			}
		}
	}
}

func TestInstallationsProjectEveryOwnerWithoutMutatingCapture(t *testing.T) {
	w := snapshotFixtureWorld()
	for _, status := range []string{"spectator", "alive", "dead"} {
		w.Players[0].Status = status
		s := wire.Capture(w)
		before := jsonBytes(t, s)
		for _, p := range s.Players {
			recipient := s.ForRecipient(p.ID)
			if recipient.Local == nil || *recipient.Local != p.Checkpoint() {
				t.Fatal("incomplete owner checkpoint", status)
			}
			if len(recipient.Players) != len(s.Players) {
				t.Fatal("roster filtered")
			}
			for i, remote := range recipient.Players {
				if !reflect.DeepEqual(remote, s.Players[i].Remote()) {
					t.Fatal("remote projection changed")
				}
			}
			if !bytes.Equal(before, jsonBytes(t, s)) {
				t.Fatal("projection changed capture")
			}
		}
		if s.ForRecipient(999).Local != nil {
			t.Fatal("missing identity reused another checkpoint")
		}
	}
}
