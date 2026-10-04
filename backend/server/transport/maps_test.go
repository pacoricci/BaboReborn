package transport

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/match"
)

func TestMapWireOrderingAndLateJoin(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	yard, err := maps.Parse(testcontent.Map("yard"))
	if err != nil {
		t.Fatal(err)
	}
	crossing, err := maps.Parse(testcontent.Map("crossing"))
	if err != nil {
		t.Fatal(err)
	}
	world := match.MustNew(testcontent.Map("yard"))
	yard.Theme = "futuristic"
	crossing.Theme = "cyberpunk"
	if err := world.ConfigureRotation([]maps.Arena{yard, crossing}, nil); err != nil {
		t.Fatal(err)
	}
	rules := match.DefaultRules()
	rules.TimeLimitTicks = 60
	rules.EndTicks = 12
	if err := world.Configure(rules); err != nil {
		t.Fatal(err)
	}
	server := New(world, 3, nil)
	go server.Run(ctx)
	httpServer := httptest.NewServer(server.Handler(ctx))
	defer httpServer.Close()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws?" + admissionQuery(compatibility.GameProfile())
	connect := func() (*websocket.Conn, int, int, string) {
		c, _, err := dialAuthenticated(ctx, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		var msg struct {
			Type      string
			ID, Round int
			Arena     maps.Arena
		}
		if err := readMessage(ctx, c, &msg); err != nil {
			t.Fatal(err)
		}
		if msg.Type != "welcome" {
			t.Fatal("missing welcome")
		}
		expectedTheme := "futuristic"
		if msg.Arena.ID == "crossing" {
			expectedTheme = "cyberpunk"
		}
		if msg.Arena.Theme != expectedTheme {
			t.Fatal("welcome lost scenario")
		}
		return c, msg.ID, msg.Round, msg.Arena.ID
	}
	a, id, round, mapID := connect()
	defer a.CloseNow() //nolint:errcheck // Test cleanup.
	if round != 1 || mapID != "yard" {
		t.Fatal("wrong initial map")
	}
	if err := writeMessage(ctx, a, Message{Type: "profile", Version: gameconfig.ProtocolVersion, Nickname: "Map tester"}); err != nil {
		t.Fatal(err)
	}
	var late *websocket.Conn
	for {
		var raw json.RawMessage
		if err := readMessage(ctx, a, &raw); err != nil {
			t.Fatal(err)
		}
		var header struct {
			Type      string
			ID, Round int
			Arena     maps.Arena
		}
		if err := json.Unmarshal(raw, &header); err != nil {
			t.Fatal(err)
		}
		if header.Type == "map" {
			if header.Round != round+1 || header.ID != id {
				t.Fatal("map sequence or identity changed")
			}
			round = header.Round
			mapID = header.Arena.ID
			expected := "yard"
			if round%2 == 0 {
				expected = "crossing"
			}
			if mapID != expected {
				t.Fatal("wrong rotation")
			}
			expectedTheme := "futuristic"
			if mapID == "crossing" {
				expectedTheme = "cyberpunk"
			}
			if header.Arena.Theme != expectedTheme {
				t.Fatal("rotation lost scenario")
			}
			if round == 2 {
				var lateRound int
				var lateMap string
				late, _, lateRound, lateMap = connect()
				defer late.CloseNow() //nolint:errcheck // Test cleanup.
				if lateRound != 2 || lateMap != "crossing" {
					t.Fatal("late join got stale map")
				}
				go func() {
					for {
						var body any
						if err := readMessage(ctx, late, &body); err != nil {
							return
						}
					}
				}()
			}
		}
		if header.Type == "snapshot" {
			// readMessage restores omitted groups against this socket's installation.
			snapshot := testClient(a).state
			if snapshot.Match.Round != round {
				t.Fatal("snapshot preceded its map geometry")
			}
			found := false
			for _, p := range snapshot.Players {
				if p.ID == id {
					found = true
					if round >= 2 && p.Nickname != "Map tester" {
						t.Fatal("profile lost")
					}
				}
			}
			if !found {
				t.Fatal("player disconnected")
			}
			if round == 3 {
				if server.Info().Map != yard.Name {
					t.Fatal("discovery retained stale map")
				}
				break
			}
		}
	}
}
