package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"baboreborn/backend/compatibility"
	catalogcontent "baboreborn/backend/content"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/internal/testwire"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/transport"
	"baboreborn/backend/server/wire"
)

func roomAdmissionQuery() string {
	return "v=" + strconv.Itoa(gameconfig.ProtocolVersion) + "&profile=" + compatibility.GameProfile() + "&content=test"
}

func TestConfiguredRoomAdvertisesMapAndAppliesAuthoritativeRules(t *testing.T) {
	var catalog []maps.Arena
	for _, data := range [][]byte{testcontent.Map("yard"), testcontent.Map("crossing")} {
		a, err := maps.Parse(data)
		if err != nil {
			t.Fatal(err)
		}
		catalog = append(catalog, a)
	}
	c := hosting.Config{Name: "Configured", Capacity: 3, Bots: 1, Rotation: []string{"crossing", "yard"}, ScoreLimit: 7, TimeLimitMinutes: 2, RespawnSeconds: 3, ForceRespawn: true}
	s, err := configuredRoom(c, []maps.Arena{catalog[1], catalog[0]}, nil, roomTestCatalog())
	if err != nil {
		t.Fatal(err)
	}
	if info := s.Info(); info.Name != c.Name || info.Map != catalog[1].Name || info.Occupied != 1 || info.Capacity != 3 {
		t.Fatal(info)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go s.Run(ctx)
	h := httptest.NewServer(s.Handler(ctx))
	defer h.Close()
	conn, _, err := dialRoom(ctx, "ws"+strings.TrimPrefix(h.URL, "http")+"/ws?"+roomAdmissionQuery(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow() //nolint:errcheck // Test socket cleanup.
	var snap wire.Snapshot
	for {
		if err := readDelivery(ctx, conn, &snap); err != nil {
			t.Fatal(err)
		}
		if snap.Type != "snapshot" {
			continue
		}
		r := snap.Match.Rules
		if r.ScoreLimit != 7 || r.TimeLimitTicks != 2*60*gameconfig.TickHz || r.RespawnTicks != 3*gameconfig.TickHz || !r.ForceRespawn || len(snap.Players) != 2 {
			t.Fatal(snap)
		}
		break
	}
}

func TestTeamRoomsOverRealSockets(t *testing.T) {
	a, err := maps.Parse(testcontent.Map("twin-forts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{match.ModeTDM, match.ModeCTF} {
		t.Run(mode, func(t *testing.T) {
			c := hosting.Config{Mode: mode, Name: "Teams", Capacity: 4, Bots: 1, Rotation: []string{a.ID}, ScoreLimit: 7, TimeLimitMinutes: 30, RespawnSeconds: 1}
			s, err := configuredRoom(c, []maps.Arena{a}, nil, roomTestCatalog())
			if err != nil {
				t.Fatal(err)
			}
			if s.Info().Mode != mode {
				t.Fatal("wrong advertised mode", s.Info())
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			go s.Run(ctx)
			h := httptest.NewServer(s.Handler(ctx))
			defer h.Close()
			clients := []*websocket.Conn{}
			states := map[*websocket.Conn]*wire.Snapshot{}
			for range 2 {
				conn, _, err := dialRoom(ctx, "ws"+strings.TrimPrefix(h.URL, "http")+"/ws?"+roomAdmissionQuery(), nil)
				if err != nil {
					t.Fatal(err)
				}
				defer conn.CloseNow() //nolint:errcheck // Test socket cleanup.
				var installation struct{ State wire.Snapshot }
				if err := readDelivery(ctx, conn, &installation); err != nil {
					t.Fatal(err)
				}
				if err := wsjson.Write(ctx, conn, map[string]any{"type": "join", "version": gameconfig.ProtocolVersion, "generation": 1}); err != nil {
					t.Fatal(err)
				}
				clients = append(clients, conn)
				states[conn] = &installation.State
			}
			for _, conn := range clients {
				snap := states[conn]
				for {
					if err := readDelivery(ctx, conn, snap); err != nil {
						t.Fatal(err)
					}
					if snap.Type != "snapshot" || len(snap.Players) != 3 {
						continue
					}
					counts := map[string]int{}
					for _, p := range snap.Players {
						counts[p.Team]++
					}
					if counts["none"] > 0 {
						continue
					}
					if counts["blue"] != 2 || counts["red"] != 1 || snap.Match.Rules.Mode != mode {
						t.Fatal(snap)
					}
					if mode == match.ModeCTF && len(snap.Flags) != 2 {
						t.Fatal("missing flags")
					}
					break
				}
			}
		})
	}
}

func dialRoom(ctx context.Context, url string, opts *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
	conn, response, err := websocket.Dial(ctx, url, opts)
	if err == nil {
		err = wsjson.Write(ctx, conn, transport.Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Guest: strings.Repeat("a", 32)})
	}
	return conn, response, err
}

func roomTestCatalog() *catalogcontent.Catalog {
	return &catalogcontent.Catalog{Revision: "test", DefaultSkin: "geometric", Skins: []catalogcontent.Skin{{Metadata: catalogcontent.Metadata{ID: "geometric"}}}}
}

func readDelivery(ctx context.Context, c *websocket.Conn, target any) error {
	var frame struct {
		replication.Envelope
		Body json.RawMessage `json:"body"`
	}
	_, raw, readErr := c.Read(ctx)
	if readErr != nil {
		return readErr
	}
	if err := testwire.Unmarshal(raw, &frame); err != nil {
		return err
	}
	expanded, err := testwire.Expand(frame.Body)
	if err != nil {
		return err
	}
	frame.Body = expanded
	if state, ok := target.(*wire.Snapshot); ok && frame.Kind == replication.Installation {
		var installation struct {
			Type  string
			State wire.Snapshot
		}
		if err := json.Unmarshal(frame.Body, &installation); err != nil {
			return err
		}
		*state = installation.State
		state.Type = installation.Type
	} else if err := json.Unmarshal(frame.Body, target); err != nil {
		return err
	}
	return wsjson.Write(ctx, c, map[string]any{"type": "receipt", "version": gameconfig.ProtocolVersion, "receipt": replication.Receipt{Connection: frame.Connection, Sequence: frame.Sequence, Generation: frame.Generation, EventThrough: frame.EventThrough}})
}
