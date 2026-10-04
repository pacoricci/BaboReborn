package wire_test

import (
	"slices"
	"testing"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/server/wire"
)

func TestRecipientCoveragePreservesOwedFactsAndFilteredGaps(t *testing.T) {
	b := wire.EventBatch{Type: "events", Version: gameconfig.ProtocolVersion, After: 10, Through: 16, Events: []wire.Event{
		{ID: 11, Kind: "hit", OwnerID: 1},
		{ID: 12, Kind: "signal", Signal: "pickup-health", OwnerID: 2},
		{ID: 13, Kind: "signal", Signal: "reload", OwnerID: 2},
		{ID: 14, Kind: "damage", OwnerID: 2},
		{ID: 15, Kind: "hit", OwnerID: 2},
		{ID: 16, Kind: "signal", Signal: "pickup-equipment", OwnerID: 1},
	}, Cues: []wire.Cue{{ID: 100, Kind: "explosion", OwnerID: 2}}}
	for _, c := range []struct {
		player, after int
		ids           []int
	}{
		{1, 10, []int{11, 13, 14, 16}},
		{2, 10, []int{12, 13, 14, 15}},
		{3, 10, []int{13, 14}},
		{1, 14, []int{16}},
		{2, 15, nil},
	} {
		out := b
		out.After = c.after
		out.Events = []wire.Event{}
		for _, e := range b.Events {
			if e.ID > c.after && e.AddressedTo(c.player) {
				out.Events = append(out.Events, e)
			}
		}
		var ids []int
		for _, e := range out.Events {
			ids = append(ids, e.ID)
		}
		if out.After != c.after || out.Through != 16 || !slices.Equal(ids, c.ids) || len(out.Cues) != 1 {
			t.Fatalf("recipient %d after %d: %+v", c.player, c.after, out)
		}
		if out.Events == nil {
			t.Fatal("empty coverage must encode an array")
		}
	}
	if len(b.Events) != 6 {
		t.Fatal("filter mutated shared events")
	}
}
