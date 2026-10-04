package transport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

// Opt-in replay: real replication selections and real compressed WebSocket
// messages. Simulation time is fixed; these rates are NOT live wall-clock rates.
func TestReplicationMeasurement(t *testing.T) {
	path := os.Getenv("REPLICATION_REPORT")
	if path == "" {
		t.Skip("set REPLICATION_REPORT for the controlled network replay")
	}
	scenarios := []string{"devices", "grenades", "pickups", "rockets", "molotov", "mixed", "ctf"}
	if only := os.Getenv("REPLICATION_SCENARIOS"); only != "" {
		scenarios = strings.Split(only, ",")
	}
	var results []any
	for _, scenario := range scenarios {
		for _, peers := range []int{1, 8, 16} {
			for _, compressed := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/%d/%t", scenario, peers, compressed), func(t *testing.T) {
					result := measureReplication(t, scenario, peers, compressed, "yard", nil)
					results = append(results, result)
					body, err := json.MarshalIndent(map[string]any{"protocol": gameconfig.ProtocolVersion, "simulatedSeconds": 30, "rates": "actual WebSocket bytes / 30 simulated seconds; not a live capacity test", "results": results}, "", "  ")
					if err != nil {
						t.Fatal(err)
					}
					if err = os.WriteFile(path, append(body, '\n'), 0600); err != nil {
						t.Fatal(err)
					}
				})
			}
		}
	}
}
func measureReplication(t *testing.T, scenario string, peers int, compressed bool, mapName string, observeState func([]byte)) any {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	mode := websocket.CompressionDisabled
	if compressed {
		mode = websocket.CompressionNoContextTakeover
	}
	accepted := make(chan *websocket.Conn, peers)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: mode})
		if err == nil {
			accepted <- c
		}
	}))
	defer srv.Close()
	var total atomic.Int64
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return countedReadConn{c, &total}, nil
	}}
	defer transport.CloseIdleConnections()
	clients := make([]*websocket.Conn, peers)
	servers := make([]*websocket.Conn, peers)
	for i := range peers {
		c, _, err := websocket.Dial(ctx, strings.Replace(srv.URL, "http", "ws", 1), &websocket.DialOptions{HTTPClient: &http.Client{Transport: transport}, CompressionMode: mode})
		if err != nil {
			t.Fatal(err)
		}
		clients[i] = c
		servers[i] = <-accepted
		c.SetReadLimit(2 << 20)
		defer func() {
			if err := c.CloseNow(); err != nil {
				t.Log(err)
			}
		}()
		defer func() {
			if err := servers[i].CloseNow(); err != nil {
				t.Log(err)
			}
		}()
	}
	w := match.MustNew(testcontent.Map(mapName))
	rules := match.DefaultRules()
	rules.ScoreLimit = 0
	rules.TimeLimitTicks = 0
	rules.RespawnTicks = 120
	if scenario == "ctf" {
		rules.Mode = match.ModeCTF
	}
	if err := w.Configure(rules); err != nil {
		t.Fatal(err)
	}
	for i := range 16 {
		p := w.Add()
		p.NextPrimary = []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"}[i%8]
		p.NextSecondary = []string{"minibot", "shield", "knives"}[i%3]
		if scenario == "rockets" {
			p.NextPrimary = "bazooka"
		}
		w.Spawn(p)
	}
	now := time.Unix(1, 0)
	replica, err := replication.New(replication.DefaultLimits(), func() time.Time { return now }, encodeDelivery)
	if err != nil {
		t.Fatal(err)
	}
	replica.Pace(30)
	if err := replica.Append(wire.CaptureRequiredEvents(w)); err != nil {
		t.Fatal(err)
	}
	w.DrainRequiredEvents()
	initial := wire.Capture(w)
	for i := range peers {
		body, err := json.Marshal(initial.ForRecipient(i + 1))
		if err != nil {
			t.Fatal(err)
		}
		if err := replica.Add(i+1, fmt.Sprintf("measurement-%02d", i), replication.Baseline{State: initial, Body: body}); err != nil {
			t.Fatal(err)
		}
	}
	type count struct {
		WireBytes              int64   `json:"wireBytes"`
		PayloadBytes           int     `json:"payloadBytes"`
		Messages               int     `json:"messages"`
		MbitPerSimulatedSecond float64 `json:"mbitPerSimulatedSecond"`
	}
	counts := map[replication.Kind]*count{}
	drain := func() {
		for i := range peers {
			for {
				packet, err := replica.Next(i + 1)
				if err != nil {
					t.Fatal(err)
				}
				if packet == nil {
					break
				}
				before := total.Load()
				kind := websocket.MessageText
				if packet.Kind == replication.State {
					kind = websocket.MessageBinary
					if observeState != nil {
						observeState(packet.Data)
					}
				}
				if err = servers[i].Write(ctx, kind, packet.Data); err != nil {
					t.Fatal(err)
				}
				_, received, err := clients[i].Read(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if string(received) != string(packet.Data) {
					t.Fatal("wire decode mismatch")
				}
				n := total.Load() - before
				group := counts[packet.Kind]
				if group == nil {
					group = &count{}
					counts[packet.Kind] = group
				}
				group.WireBytes += n
				group.PayloadBytes += len(packet.Data)
				group.Messages++
				if err = replica.Written(i+1, packet.Receipt, nil); err != nil {
					t.Fatal(err)
				}
				receipt, err := json.Marshal(packet.Receipt)
				if err != nil {
					t.Fatal(err)
				}
				if err = clients[i].Write(ctx, websocket.MessageText, receipt); err != nil {
					t.Fatal(err)
				}
				_, receipt, err = servers[i].Read(ctx)
				if err != nil {
					t.Fatal(err)
				}
				var ack replication.Receipt
				if err = json.Unmarshal(receipt, &ack); err != nil {
					t.Fatal(err)
				}
				if err = replica.Acknowledge(i+1, ack); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	drain()
	digest := sha256.New()
	enc := json.NewEncoder(digest)
	kinds := map[string]int{}
	for tick := 1; tick <= 30*120; tick++ {
		now = time.Unix(1, 0).Add(time.Duration(tick) * time.Second / 120)
		w.TimeMS = int64(tick) * 1000 / gameconfig.TickHz
		for i, p := range w.Players {
			if p.Status != "alive" {
				w.Spawn(p)
			}
			angle := float64(tick)/180 + float64(i)*math.Pi/4
			input := core.Input{X: math.Cos(angle), Y: math.Sin(angle), Aim: core.Vec2{X: 16 + math.Cos(angle+1)*4, Y: 16 + math.Sin(angle+1)*4}, Fire: (scenario == "mixed" || scenario == "ctf" || scenario == "pickups" || scenario == "rockets") && tick%480 < 360, Secondary: tick%240 == 1, Grenade: (scenario == "grenades" || scenario == "mixed" || scenario == "ctf") && tick%360 == 1, Molotov: (scenario == "molotov" || scenario == "mixed" || scenario == "ctf") && tick%600 == 1}
			if err := w.Submit(p, []match.Command{{Seq: tick, Life: p.Life, Input: input}}); err != nil {
				t.Fatal(err)
			}
		}
		w.Step()
		// Hash physical authority, never the versioned wire projection or motion cache.
		for _, p := range w.Players {
			if err := enc.Encode([]any{p.ID, p.State, p.HP, p.Status, p.Life, p.Score}); err != nil {
				t.Fatal(err)
			}
		}
		for _, p := range w.Projectiles {
			kinds[p.Kind]++
			if err := enc.Encode([]any{p.ID, p.Kind, p.Owner, p.Born, p.Expires, p.Attached, p.Flight, p.Turret}); err != nil {
				t.Fatal(err)
			}
		}
		for _, p := range w.Items {
			kinds["pickup"]++
			if err := enc.Encode([]any{p.ID, p.Kind, p.Primary, p.Expires, p.Flight}); err != nil {
				t.Fatal(err)
			}
		}
		if err := enc.Encode([]any{w.Flags, w.Events, w.Cues}); err != nil {
			t.Fatal(err)
		}
		if err := replica.Append(wire.CaptureRequiredEvents(w)); err != nil {
			t.Fatal(err)
		}
		w.DrainRequiredEvents()
		if tick%4 == 0 {
			if err := replica.Publish(wire.Capture(w)); err != nil {
				t.Fatal(err)
			}
			if err := replica.OfferCues(w.Match.Round, w.Tick, wire.CaptureCues(w), now); err != nil {
				t.Fatal(err)
			}
			w.DrainCues()
			drain()
		}
	}
	for _, c := range counts {
		c.MbitPerSimulatedSecond = float64(c.WireBytes) * 8 / 30 / 1e6
	}
	return map[string]any{"scenario": scenario, "peers": peers, "compressed": compressed, "traffic": counts, "authoritySHA256": hex.EncodeToString(digest.Sum(nil)), "entityTicks": kinds}
}
