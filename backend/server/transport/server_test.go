package transport

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
	"baboreborn/backend/server/wire"
)

func versionQueryFor(version int) string   { return "v=" + strconv.Itoa(version) }
func versionQuery() string                 { return versionQueryFor(gameconfig.ProtocolVersion) }
func admissionQuery(profile string) string { return versionQuery() + "&profile=" + profile }

func TestTwoConnectionsReleaseInvalidAndReconnect(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	world := match.MustNew(testcontent.Map("yard"))
	world.ConfigureSkins(map[string]bool{"geometric": true, "hexagons": true}, "geometric")
	s := New(world, 2, nil)
	go s.Run(ctx)
	httpServer := httptest.NewServer(s.Handler(ctx))
	defer httpServer.Close()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws?" + admissionQuery(compatibility.GameProfile())
	connect := func() (*websocket.Conn, int) {
		c, _, err := dialAuthenticated(ctx, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		var msg struct {
			ID   int
			Type string
		}
		if err = readMessage(ctx, c, &msg); err != nil || msg.Type != "welcome" {
			t.Fatal(err, msg)
		}
		return c, msg.ID
	}
	a, aid := connect()
	defer a.CloseNow() //nolint:errcheck // Cleanup includes sockets deliberately closed by this test.
	b, bid := connect()
	defer b.CloseNow() //nolint:errcheck // Cleanup includes sockets deliberately closed by this test.
	if aid == bid {
		t.Fatal("duplicate identity")
	}
	read := func(c *websocket.Conn) receivedSnapshot {
		for {
			var snap receivedSnapshot
			if err := readMessage(ctx, c, &snap); err != nil {
				t.Fatal(err)
			}
			if snap.Type == "snapshot" {
				return snap
			}
		}
	}
	if err := writeMessage(ctx, a, Message{Type: "profile", Version: gameconfig.ProtocolVersion, Nickname: "Rolling Babo"}); err != nil {
		t.Fatal(err)
	}
	chosen := wire.Appearance{Template: "hexagons", Colors: []string{"#abcdef", "#123456", "#654321"}}
	if err := writeMessage(ctx, a, Message{Type: "appearance", Version: gameconfig.ProtocolVersion, Appearance: chosen}); err != nil {
		t.Fatal(err)
	}
	if err := writeMessage(ctx, a, Message{Type: "join", Version: gameconfig.ProtocolVersion}); err != nil {
		t.Fatal(err)
	}
	var snap receivedSnapshot
	for {
		snap = read(a)
		if len(snap.Players) == 2 && snap.Players[0].Status == "alive" {
			break
		}
	}
	if snap.Players[1].Status != "spectator" {
		t.Fatal("auto spawn")
	}
	if snap.Players[0].Appearance.Template != "hexagons" || snap.Players[0].Appearance.Colors[0] != "#abcdef" {
		t.Fatal("local appearance missing", snap)
	}
	for {
		remote := read(b)
		if len(remote.Players) == 2 && remote.Players[0].Status == "alive" {
			if remote.Players[0].Nickname != "Rolling Babo" {
				t.Fatal("remote nickname mismatch", remote)
			}
			if remote.Players[0].Appearance.Template != "hexagons" || remote.Players[0].Appearance.Colors[0] != "#abcdef" || remote.Players[1].Appearance.Template != "geometric" {
				t.Fatal("remote appearance mismatch", remote)
			}
			break
		}
	}
	// An extra client is rejected before allocating an identity.
	full, _, err := dialAuthenticated(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer full.CloseNow() //nolint:errcheck // Cleanup includes sockets deliberately closed by this test.
	_, _, err = full.Read(ctx)
	if websocket.CloseStatus(err) != CloseRoomFull {
		t.Fatal("capacity", err)
	}
	// Arbitrary position fields cannot cross the input contract.
	invalid := []byte(`{"type":"input","version":` + strconv.Itoa(gameconfig.ProtocolVersion) + `,"inputs":[{"seq":1,"life":1,"x":1,"y":0,"aim":{"x":10,"y":4},"fire":false,"position":{"x":100}}]}`)
	if _, err := decodeMessage(invalid); err == nil || !strings.Contains(err.Error(), `unknown field "position"`) {
		t.Fatalf("input field rejection: %v", err)
	}
	if err := a.Write(ctx, websocket.MessageText, invalid); err != nil {
		t.Fatal(err)
	}
	for {
		_, _, err = a.Read(ctx)
		if err != nil {
			break
		}
	}
	for {
		snap = read(b)
		if len(snap.Players) == 1 {
			break
		}
	}
	c, cid := connect()
	defer c.CloseNow() //nolint:errcheck // Cleanup includes sockets deliberately closed by this test.
	if cid <= bid {
		t.Fatal("reused stale identity")
	}
	// Verify the snapshot is serializable without leaking internal input queues.
	data, err := json.Marshal(read(c))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "queue") {
		t.Fatal("internal state exposed")
	}
	if s.Stats().Rejected == 0 {
		t.Fatal("invalid message not recorded")
	}
}

// Synthetic arena and short limits exercise the actual wire adapter and repeated
// rounds; they are not a playtest or a production network-performance measurement.
func TestDeathmatchWireActionsAndConsecutiveRounds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	world := match.MustNew(testcontent.Map("yard"))
	rules := match.DefaultRules()
	rules.TimeLimitTicks = 720
	rules.EndTicks = 24
	if err := world.Configure(rules); err != nil {
		t.Fatal(err)
	}
	s := New(world, 2, nil)
	go s.Run(ctx)
	httpServer := httptest.NewServer(s.Handler(ctx))
	defer httpServer.Close()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws?" + admissionQuery(compatibility.GameProfile())
	connect := func() *websocket.Conn {
		c, _, err := dialAuthenticated(ctx, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		var welcome any
		if err := readMessage(ctx, c, &welcome); err != nil {
			t.Fatal(err)
		}
		return c
	}
	a, b := connect(), connect()
	defer a.CloseNow() //nolint:errcheck // Test cleanup.
	defer b.CloseNow() //nolint:errcheck // Test cleanup.
	write := func(c *websocket.Conn, m Message) {
		m.Version = gameconfig.ProtocolVersion
		if err := writeMessage(ctx, c, m); err != nil {
			t.Fatal(err)
		}
	}
	write(a, Message{Type: "select", Primary: "shotgun", Secondary: "shield"})
	write(b, Message{Type: "select", Primary: "smg", Secondary: "knives"})
	write(a, Message{Type: "join"})
	write(b, Message{Type: "join"})
	// Drain the second client so its reliable outbound queue remains available.
	go func() {
		for {
			var body any
			if err := readMessage(ctx, b, &body); err != nil {
				return
			}
		}
	}()
	seq := []int{0, 0}
	seen := map[string]bool{}
	changed := false
	lastInputTick := -1
	for {
		var snap receivedSnapshot
		if err := readMessage(ctx, a, &snap); err != nil {
			t.Fatal(err)
		}
		if snap.Type != "snapshot" {
			continue
		}
		for _, effect := range snap.Delivery.Cues {
			seen["effect-"+effect.Kind] = true
		}
		if snap.Tick <= lastInputTick {
			continue
		}
		lastInputTick = snap.Tick
		if snap.Match.Phase == "intermission" {
			seen["intermission"] = true
			continue
		}
		if snap.Match.Round == 3 {
			break
		}
		if len(snap.Players) != 2 {
			continue
		}
		for i, p := range snap.Players {
			conn := a
			if i == 1 {
				conn = b
			}
			if p.Status == "dead" {
				write(conn, Message{Type: "respawn"})
				continue
			}
			if p.Status != "alive" {
				continue
			}
			e := p.State.Equipment
			seen[e.Primary] = true
			if e.Protection > 0 {
				seen["shield"] = true
			}
			if e.MeleeDelay > 0 && e.Secondary == "knives" {
				seen["knives"] = true
			}
			if e.Grenades < 2 {
				seen["grenade"] = true
			}
			if e.Molotovs < 1 {
				seen["molotov"] = true
			}
			age := snap.Tick - p.BornTick
			input := core.Input{Aim: core.Vec2{X: p.State.X + 3, Y: p.State.Y}}
			if snap.Match.Round == 1 {
				input.Fire = i == 0 && age >= 145 && age < 155
				input.Secondary = age >= 225 && age < 235
				input.Grenade = i == 1 && age >= 350 && age < 358
				input.Molotov = i == 1 && age >= 474 && age < 480
			} else {
				input.Molotov = age >= 125 && age < 133
				input.Fire = age >= 260 && age < 330
			}
			commands := make([]match.Command, 4)
			for j := range commands {
				seq[i]++
				commands[j] = match.Command{Seq: seq[i], Life: p.Life, Input: input}
				input.Grenade = false
				input.Molotov = false
			}
			write(conn, Message{Type: "input", Inputs: commands})
		}
		if !changed && snap.Tick > 60 {
			write(a, Message{Type: "select", Primary: "smg", Secondary: "knives"})
			changed = true
		}
		if snap.Match.Round == 1 && changed && snap.Players[0].State.Equipment.Primary != "shotgun" {
			t.Fatal("selection replaced live weapon")
		}
		if snap.Match.Round == 2 && snap.Players[0].Status == "alive" && snap.Players[0].State.Equipment.Primary != "smg" {
			t.Fatal("next spawn selection missing")
		}
	}
	for _, key := range []string{"shotgun", "smg", "shield", "knives", "grenade", "molotov", "intermission", "effect-knives", "effect-explosion"} {
		if !seen[key] {
			t.Errorf("wire flow did not exercise %s", key)
		}
	}
}

// Bots occupy ordinary capacity and are published through the existing player
// snapshots. This exercises a real human socket alongside two autonomous rivals.
func TestBotsShareCapacityAndHumanWireFlow(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	w := match.MustNew(testcontent.Map("yard"))
	// Compare with the authority's names, not a duplicated nickname format.
	nicknames := map[int]string{}
	for i := 0; i < 2; i++ {
		bot, err := w.AddBot(bots.NewSimple(bots.Standard(), uint32(9109+i)), navigation.New(w.Geometry.Grid))
		if err != nil {
			t.Fatal(err)
		}
		nicknames[bot.ID] = bot.Nickname
	}
	s := New(w, 3, nil)
	go s.Run(ctx)
	httpServer := httptest.NewServer(s.Handler(ctx))
	defer httpServer.Close()
	url := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws?" + admissionQuery(compatibility.GameProfile())
	c, _, err := dialAuthenticated(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow() //nolint:errcheck // Test cleanup.
	var welcome struct {
		ID   int
		Type string
	}
	if err := readMessage(ctx, c, &welcome); err != nil || welcome.Type != "welcome" {
		t.Fatal(err, welcome)
	}
	if err := writeMessage(ctx, c, Message{Type: "join", Version: gameconfig.ProtocolVersion}); err != nil {
		t.Fatal(err)
	}
	full, _, err := dialAuthenticated(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer full.CloseNow() //nolint:errcheck // Rejected connection cleanup.
	if _, _, err := full.Read(ctx); websocket.CloseStatus(err) != CloseRoomFull {
		t.Fatal("bots did not count toward capacity", err)
	}
	initial := map[int]core.Vec2{}
	for {
		var snap receivedSnapshot
		if err := readMessage(ctx, c, &snap); err != nil {
			t.Fatal(err)
		}
		if snap.Type != "snapshot" {
			continue
		}
		if len(snap.Players) != 3 {
			t.Fatal("missing bots or human", snap.Players)
		}
		moved := 0
		for _, p := range snap.Players {
			if p.ID == welcome.ID {
				continue
			}
			if nickname, ok := nicknames[p.ID]; !ok || p.Nickname != nickname || !core.IsPrimary(p.State.Equipment.Primary) ||
				!core.IsSecondary(p.State.Equipment.Secondary) {
				t.Fatal("bot player metadata missing", p)
			}
			pos := core.Vec2{X: p.State.X, Y: p.State.Y}
			if start, ok := initial[p.ID]; !ok {
				initial[p.ID] = pos
			} else if math.Hypot(pos.X-start.X, pos.Y-start.Y) > .5 {
				moved++
			}
		}
		if moved == 2 && snap.Players[2].Status == "alive" {
			break
		}
	}
}

func TestFullCatalogAcrossTwoConnections(t *testing.T) {
	for _, primary := range []string{"smg", "shotgun", "dual", "chain", "sniper", "bazooka", "photon", "flamethrower"} {
		for _, secondary := range []string{"knives", "shield", "minibot"} {
			t.Run(primary+"-"+secondary, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
				go s.Run(ctx)
				h := httptest.NewServer(s.Handler(ctx))
				defer h.Close()
				url := "ws" + strings.TrimPrefix(h.URL, "http") + "/ws?" + admissionQuery(compatibility.GameProfile())
				var clients []*websocket.Conn
				var id int
				for range 2 {
					c, _, err := dialAuthenticated(ctx, url, nil)
					if err != nil {
						t.Fatal(err)
					}
					defer c.CloseNow() //nolint:errcheck // Socket cleanup.
					var welcome struct {
						ID      int
						Version int
					}
					if err := readMessage(ctx, c, &welcome); err != nil || welcome.Version != gameconfig.ProtocolVersion {
						t.Fatal(err, welcome)
					}
					if len(clients) == 0 {
						id = welcome.ID
					}
					clients = append(clients, c)
				}
				// Selection is private server state until the chosen equipment spawns.
				for _, m := range []Message{
					{Type: "select", Version: gameconfig.ProtocolVersion, Primary: primary, Secondary: secondary},
					{Type: "join", Version: gameconfig.ProtocolVersion},
				} {
					if err := writeMessage(ctx, clients[0], m); err != nil {
						t.Fatal(err)
					}
				}
				for _, conn := range clients {
					found := false
					for !found {
						var snapshot receivedSnapshot
						if err := readMessage(ctx, conn, &snapshot); err != nil {
							t.Fatal(err)
						}
						if snapshot.Type != "snapshot" {
							continue
						}
						if snapshot.Version != gameconfig.ProtocolVersion {
							t.Fatal("wire version")
						}
						for _, p := range snapshot.Players {
							if p.ID == id && p.Status == "alive" && p.State.Equipment.Primary == primary && p.State.Equipment.Secondary == secondary {
								found = true
							}
						}
					}
				}
			})
		}
	}
}

func TestTwoClientsReceiveAuthoritativeTurretPose(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	world := match.MustNew([]byte(`{"name":"Turret wire","schema":1,"theme":"classic","id":"synthetic","author":"Tests","width":12,"height":12,"walls":[],"spawns":[{"x":4,"y":4},{"x":4,"y":6}]}`))
	owner, target := world.Add(), world.Add()
	world.Spawn(owner)
	world.Spawn(target)
	owner.State.X = 4
	owner.State.Y = 4
	target.State.X = 4
	target.State.Y = 6
	world.Projectiles = append(world.Projectiles, &match.Projectile{ID: 1, Kind: "minibot", Owner: owner.ID, Born: 0, Expires: 600,
		Flight: core.Flight{Position: core.Vec3{X: 5, Y: 4, Z: .15}}, Turret: &match.TurretPresentation{}})
	s := New(world, 4, nil)
	go s.Run(ctx)
	h := httptest.NewServer(s.Handler(ctx))
	defer h.Close()
	url := "ws" + strings.TrimPrefix(h.URL, "http") + "/ws?" + admissionQuery(compatibility.GameProfile())
	for range 2 {
		conn, _, err := dialAuthenticated(ctx, url, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.CloseNow() //nolint:errcheck // Test socket cleanup.
		for {
			var snapshot receivedSnapshot
			if err = readMessage(ctx, conn, &snapshot); err != nil {
				t.Fatal(err)
			}
			if snapshot.Type != "snapshot" {
				continue
			}
			if snapshot.Version != gameconfig.ProtocolVersion {
				t.Fatal("protocol version", snapshot.Version)
			}
			if len(snapshot.Projectiles) == 0 || snapshot.Projectiles[0].Turret.LastShotTick == 0 {
				continue
			}
			turret := snapshot.Projectiles[0].Turret
			if math.Abs(turret.Angle-math.Atan2(2, -1)) > 1e-9 || turret.LastShotTick > snapshot.Tick {
				t.Fatal("invalid turret pose on wire", turret, snapshot.Tick)
			}
			break
		}
	}
}

func TestContentRevisionRejectsStaleAdmission(t *testing.T) {
	s := New(match.MustNew(testcontent.Map("yard")), 2, nil)
	s.ContentRevision = "new-catalog"
	response := httptest.NewRecorder()
	s.Handler(context.Background()).ServeHTTP(response, httptest.NewRequest("GET", "/ws?"+admissionQuery(compatibility.GameProfile())+"&content=old-catalog", nil))
	if response.Code != 426 || !strings.Contains(response.Body.String(), "content_changed") {
		t.Fatalf("stale admission: %d %s", response.Code, response.Body.String())
	}
}

func dialAuthenticated(ctx context.Context, url string, opts *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
	conn, response, err := websocket.Dial(ctx, url, opts)
	if err == nil && !strings.Contains(url, "info=1") {
		err = writeMessage(ctx, conn, Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion, Guest: strings.Repeat("a", 32)})
	}
	return conn, response, err
}
