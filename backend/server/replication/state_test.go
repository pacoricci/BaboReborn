package replication

import (
	"encoding/json"
	"testing"
	"time"

	"baboreborn/backend/core"
	"baboreborn/backend/server/wire"
)

func groupState(tick int) wire.Snapshot {
	s := state(tick, 0, 1)
	s.Players = []wire.Player{{ID: 1, Team: "blue", Nickname: "First", Appearance: wire.Appearance{Template: "geometric", Colors: []string{"#123456"}}, State: core.Player{X: 4}}}
	s.Items = []wire.Item{}
	s.Match.Phase = "playing"
	s.Match.Rules.Mode = "tdm"
	s.Match.Ranking = []wire.Standing{{ID: 1, Team: "blue"}}
	return s
}
func publishState(t *testing.T, f *fixture, s wire.Snapshot) {
	t.Helper()
	if err := f.room.Publish(s); err != nil {
		t.Fatal(err)
	}
}
func transmittedFields(t *testing.T, p *Packet) (map[string]json.RawMessage, []map[string]json.RawMessage) {
	t.Helper()
	fields := body[map[string]json.RawMessage](t, p)
	var m map[string]json.RawMessage
	var players []map[string]json.RawMessage
	if err := json.Unmarshal(fields["match"], &m); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(fields["players"], &players); err != nil {
		t.Fatal(err)
	}
	return m, players
}
func installGroups(t *testing.T, f *fixture, id int, s wire.Snapshot) {
	t.Helper()
	if err := f.room.Add(id, string(rune('a'+id)), baseline(t, s)); err != nil {
		t.Fatal(err)
	}
	f.finish(id, f.take(id, Installation), true)
}

func TestStandingsAreLimitedToFourHzWhileCombatContinues(t *testing.T) {
	f := setup(t, nil)
	s := groupState(0)
	installGroups(t, f, 1, s)
	sent := 0
	start := f.now
	for tick := 1; tick <= 120; tick++ {
		f.now = start.Add(time.Duration(tick) * time.Second / 120)
		s.Tick = tick
		s.Players[0].HP = float64(100 - tick)
		s.Players[0].State.X = float64(tick)
		s.Match.Scores.Blue = tick
		s.Match.Ranking[0].Score = tick
		publishState(t, f, s)
		packet := f.take(1, State)
		m, players := transmittedFields(t, packet)
		if _, ok := players[0]["team"]; ok {
			t.Fatal("unchanged metadata repeated")
		}
		if _, ok := m["rules"]; ok {
			t.Fatal("unchanged rules repeated")
		}
		if _, ok := m["ranking"]; ok {
			sent++
			if string(m["scores"]) != string(marshal(t, s.Match.Scores)) {
				t.Fatal("scores and ranking diverged")
			}
		}
		dynamic := body[wire.Snapshot](t, packet)
		if dynamic.Players[0].HP != s.Players[0].HP || dynamic.Players[0].State.X != float64(tick) {
			t.Fatal("combat was throttled")
		}
		f.finish(1, packet, true)
	}
	if sent != 4 {
		t.Fatalf("standings updates in one second: %d", sent)
	}
	s.Tick++
	s.Match.Phase = "intermission"
	s.Match.Ranking[0].Score++
	s.Match.Scores.Blue++
	publishState(t, f, s)
	packet := f.take(1, State)
	m, _ := transmittedFields(t, packet)
	if m["ranking"] == nil || m["scores"] == nil {
		t.Fatal("final result was delayed")
	}
}

func TestMetadataAndRulesSurviveReplacementForEachPeer(t *testing.T) {
	f := setup(t, func(l *Limits) { l.WindowFrames = l.ControlReserveFrames + 1 })
	s := groupState(0)
	installGroups(t, f, 1, s)
	installGroups(t, f, 2, s)
	s.Tick = 1
	publishState(t, f, s)
	first := f.take(1, State)
	f.finish(1, first, false)
	s.Tick = 2
	s.Players[0].Team = "red"
	s.Players[0].Nickname = "Renamed"
	s.Players[0].Appearance.Colors[0] = "#abcdef"
	s.Match.Rules.ScoreLimit = 10
	s.Match.Ranking[0].Team = "red"
	s.Match.Ranking[0].Score = 4
	publishState(t, f, s)
	if p, err := f.room.Next(1); err != nil || p != nil {
		t.Fatal("credit bypassed", err)
	}
	s.Tick = 3
	publishState(t, f, s)
	s.Players[0].Team = "none" // Mutating producer data cannot alter retained components.
	s.Players[0].Appearance.Colors[0] = "#ffffff"
	if err := f.room.Acknowledge(1, first.Receipt); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int{1, 2} {
		p := f.take(id, State)
		m, players := transmittedFields(t, p)
		if string(players[0]["team"]) != `"red"` || string(players[0]["nickname"]) != `"Renamed"` || string(players[0]["appearance"]) != `{"colors":["#abcdef"],"template":"geometric"}` {
			t.Fatal(players)
		}
		if m["rules"] == nil || m["ranking"] == nil {
			t.Fatal("team/rules transition lacked coherent standings")
		}
		f.finish(id, p, true)
	}
}

func TestInstallationResetsAllSlowGroupsAndUnsentStandings(t *testing.T) {
	f := setup(t, nil)
	s := groupState(0)
	installGroups(t, f, 1, s)
	for _, round := range []int{1, 2} {
		s.Tick++
		s.Match.Round = round
		s.Players[0].Nickname = "Installed"
		s.Match.Ranking[0].Score++
		if err := f.room.Install(1, baseline(t, s)); err != nil {
			t.Fatal(err)
		}
		p := f.take(1, Installation)
		f.finish(1, p, true)
		s.Tick++
		publishState(t, f, s)
		p = f.take(1, State)
		m, players := transmittedFields(t, p)
		if m["rules"] != nil || m["ranking"] != nil || players[0]["nickname"] != nil {
			t.Fatal("installation did not reset baseline")
		}
		f.finish(1, p, true)
	}
}

func TestColorOnlyChangesPublishMetadataAndResetWithoutRepeatingIt(t *testing.T) {
	f := setup(t, nil)
	s := groupState(0)
	installGroups(t, f, 1, s)
	for _, colors := range []string{"ff0000------0000ff------ffffff", ""} {
		s.Tick++
		s.Players[0].NicknameColors = colors
		publishState(t, f, s)
		packet := f.take(1, State)
		_, players := transmittedFields(t, packet)
		if string(players[0]["nickname"]) != `"First"` {
			t.Fatal("color-only change omitted metadata")
		}
		var actual string
		if raw := players[0]["nicknameColors"]; raw != nil {
			if err := json.Unmarshal(raw, &actual); err != nil {
				t.Fatal(err)
			}
		}
		if actual != colors {
			t.Fatalf("colors: got %q want %q", actual, colors)
		}
		f.finish(1, packet, true)
		s.Tick++
		publishState(t, f, s)
		packet = f.take(1, State)
		_, players = transmittedFields(t, packet)
		if players[0]["nickname"] != nil || players[0]["nicknameColors"] != nil {
			t.Fatal("unchanged metadata repeated")
		}
		f.finish(1, packet, true)
	}
}

func TestMetadataComparisonOwnsColorsAndPreservesPresence(t *testing.T) {
	s := groupState(4)
	s.Players[0].Appearance.Colors = []string{"#aabbcc"}
	first, err := captureCheckpoint(s, nil)
	if err != nil {
		t.Fatal(err)
	}
	same, err := captureCheckpoint(s, first)
	if err != nil || !sameMetadata(first.groups.metadata, same.groups.metadata) {
		t.Fatal("identical capture changed metadata", err)
	}
	s.Players[0].Appearance.Colors[0] = "#112233"
	changed, err := captureCheckpoint(s, same)
	if err != nil {
		t.Fatal(err)
	}
	if sameMetadata(first.groups.metadata, changed.groups.metadata) || first.groups.metadata[0].Colors[0] != "#aabbcc" {
		t.Fatal("producer mutation changed retained metadata")
	}
	// Missing colors and an explicitly empty palette have distinct presence.
	a := []playerMetadata{{Colors: nil}}
	b := []playerMetadata{{Colors: []string{}}}
	if sameMetadata(a, b) {
		t.Fatal("nil and empty colors compared equal")
	}
}
