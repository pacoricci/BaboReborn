package match

import "testing"

func TestStandingsOwnCurrentAndFrozenRows(t *testing.T) {
	w, a, b := equipPair()
	a.Score, b.Score = 3, 8
	rows := w.Standings()
	if len(rows) != 2 || rows[0].ID != b.ID {
		t.Fatal("live ranking changed")
	}
	rows[0].Score = 99
	if w.Standings()[0].Score != 8 {
		t.Fatal("live ranking retained consumer data")
	}
	w.Match.Phase = "intermission"
	w.Match.Ranking = w.ranking()
	rows = w.Standings()
	rows[0].Score = 99
	w.Remove(b.ID)
	if frozen := w.Standings(); len(frozen) != 2 || frozen[0].ID != b.ID || frozen[0].Score != 8 {
		t.Fatal("frozen standings lost ownership or disconnected participant")
	}
}
