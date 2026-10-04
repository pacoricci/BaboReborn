package administration

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	jose "github.com/go-jose/go-jose/v4"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/identity"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/internal/testwire"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/access"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/storage"
	"baboreborn/backend/server/transport"
)

const ownerID = "11111111111111111111111111111111"
const adminID = "22222222222222222222222222222222"
const modID = "33333333333333333333333333333333"
const playerID = "44444444444444444444444444444444"

type fixture struct {
	s      *Service
	server *httptest.Server
	owner  *http.Cookie
	signer *identity.Signer
	ctx    context.Context
	cancel context.CancelFunc
}

func setup(t *testing.T) *fixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	local, err := storage.OpenLocal(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := local.Close(); err != nil {
			t.Error(err)
		}
	})
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var signer *identity.Signer
	center := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/identity/v1/keys":
			identity.JSON(w, 200, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{signer.Public}})
		case strings.HasPrefix(r.URL.Path, "/identity/v1/accounts/"):
			identity.JSON(w, 200, identity.Account{ID: strings.TrimPrefix(r.URL.Path, "/identity/v1/accounts/")})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(center.Close)
	signer, err = identity.NewSigner(key, "test", center.URL)
	if err != nil {
		t.Fatal(err)
	}
	var handler http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	t.Cleanup(server.Close)
	auth, err := access.New(access.Config{Server: "test-server", Origin: server.URL, Central: center.URL, Development: true, KeysPath: filepath.Join(t.TempDir(), "keys.json")})
	if err != nil {
		t.Fatal(err)
	}
	if err := auth.RefreshKeys(ctx); err != nil {
		t.Fatal(err)
	}
	arena, err := maps.Parse(testcontent.Map("yard"))
	if err != nil {
		t.Fatal(err)
	}
	rooms := hosting.New(ctx, []hosting.MapInfo{{ID: arena.ID, Name: arena.Name, CTF: arena.Teams != nil}}, func(_ context.Context, c hosting.Config) (*transport.Server, error) {
		world := match.MustNew(testcontent.Map("yard"))
		rules := match.DefaultRules()
		rules.ScoreLimit = c.ScoreLimit
		if err := world.Configure(rules); err != nil {
			return nil, err
		}
		s := transport.New(world, c.Capacity, nil)
		s.SetName(c.Name)
		return s, nil
	}, 8)
	s := New(ctx, local.DB, auth, rooms)
	s.Warning = 100 * time.Millisecond
	if _, err := local.DB.Exec("INSERT INTO association(singleton,central,private_key,server_id,owner_id,revision) VALUES(1,$1,$2,'test-server',$3,1)", center.URL, make([]byte, 64), ownerID); err != nil {
		t.Fatal(err)
	}
	handler = s.Handler(rooms)
	f := &fixture{s: s, server: server, ctx: ctx, cancel: cancel, signer: signer}
	f.owner = f.login(t, ownerID)
	return f
}
func (f *fixture) login(t *testing.T, id string) *http.Cookie {
	t.Helper()
	tokens, err := f.signer.Issue(id, "test-server", identity.ID(), time.Now(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return &http.Cookie{Name: "proof", Value: tokens.Proof}
}
func (f *fixture) request(t *testing.T, cookie *http.Cookie, method, path string, body any) (int, []byte) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Origin", f.server.URL)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Guest-ID", strings.Repeat("e", 32))
	if cookie != nil {
		r.Header.Set("Authorization", "Bearer "+cookie.Value)
	}
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	data, err = io.ReadAll(response.Body)
	if e := response.Body.Close(); err == nil {
		err = e
	}
	if err != nil {
		t.Fatal(err)
	}
	return response.StatusCode, data
}
func (f *fixture) setRole(t *testing.T, id, next string) {
	t.Helper()
	status, data := f.request(t, f.owner, "POST", "/api/v1/admin/roles", map[string]string{"account": id, "role": next})
	if status != 200 {
		t.Fatal(status, string(data))
	}
}
func config() hosting.Config {
	return hosting.Config{Name: "Persistent room", Mode: "dm", Capacity: 4, Rotation: []string{"yard"}, ScoreLimit: 50}
}
func (f *fixture) create(t *testing.T) string {
	t.Helper()
	status, data := f.request(t, f.owner, "POST", "/api/v1/admin/rooms", map[string]any{"config": config()})
	if status != 201 {
		t.Fatal(status, string(data))
	}
	var directory hosting.Directory
	if err := json.Unmarshal(data, &directory); err != nil {
		t.Fatal(err)
	}
	return directory.CreatedRoomID
}
func (f *fixture) connect(t *testing.T, id string, cookie *http.Cookie) *websocket.Conn {
	t.Helper()
	header := http.Header{"Origin": {f.server.URL}}
	target := "ws" + strings.TrimPrefix(f.server.URL, "http") + "/ws?room=" + id + "&v=" + fmt.Sprint(gameconfig.ProtocolVersion) + "&profile=" + compatibility.GameProfile()
	c, _, err := websocket.Dial(f.ctx, target, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.CloseNow() }) //nolint:errcheck // Test cleanup also covers deliberately closed sockets.
	auth := transport.Authentication{Type: "authenticate", Version: gameconfig.ProtocolVersion}
	if cookie != nil {
		auth.Proof = cookie.Value
	} else {
		auth.Guest = strings.Repeat("e", 32)
	}
	if err := wsjson.Write(f.ctx, c, auth); err != nil {
		t.Fatal(err)
	}
	var welcome map[string]any
	if err := readDelivery(f.ctx, c, &welcome); err != nil {
		t.Fatal(err)
	}
	if welcome["type"] != "welcome" {
		t.Fatal("missing welcome")
	}
	return c
}
func TestPolicyAndAtomicSanctionsAcrossSessionsAndRooms(t *testing.T) {
	f := setup(t)
	f.setRole(t, adminID, "admin")
	f.setRole(t, modID, "moderator")
	admin, mod := f.login(t, adminID), f.login(t, modID)
	for _, attempt := range []struct {
		cookie  *http.Cookie
		target  string
		minutes int
	}{{admin, "account:" + ownerID, 5}, {admin, "account:" + adminID, 5}, {mod, "account:" + adminID, 5}, {mod, "account:" + modID, 5}, {mod, "account:" + playerID, 0}} {
		status, _ := f.request(t, attempt.cookie, "POST", "/api/v1/admin/sanctions", map[string]any{"target": attempt.target, "minutes": attempt.minutes, "reason": "forbidden"})
		if status != 403 {
			t.Fatal("hierarchy accepted", status)
		}
	}
	roomA, roomB := f.create(t), f.create(t)
	a := f.connect(t, roomA, f.login(t, playerID))
	b := f.connect(t, roomB, f.login(t, playerID))
	if _, err := f.s.DB.Exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected'); END"); err != nil {
		t.Fatal(err)
	}
	status, _ := f.request(t, mod, "POST", "/api/v1/admin/sanctions", map[string]any{"target": "account:" + playerID, "minutes": 5, "reason": "must roll back"})
	if status != 503 {
		t.Fatal("database failure hidden", status)
	}
	var count int
	if err := f.s.DB.QueryRow("SELECT COUNT(*) FROM sanctions").Scan(&count); err != nil || count != 0 {
		t.Fatal("partial sanction", count, err)
	}
	people, err := f.s.Rooms.Participants(f.ctx)
	if err != nil || len(people) != 2 {
		t.Fatal("failed save disconnected players", len(people), err)
	}
	if _, err := f.s.DB.Exec("DROP TRIGGER reject_event"); err != nil {
		t.Fatal(err)
	}
	status, data := f.request(t, admin, "POST", "/api/v1/admin/sanctions", map[string]any{"target": "account:" + playerID, "minutes": 0, "reason": "permanent explanation"})
	if status != 200 {
		t.Fatal(status, string(data))
	}
	for _, c := range []*websocket.Conn{a, b} {
		ctx, cancel := context.WithTimeout(f.ctx, 3*time.Second)
		for {
			_, _, err := c.Read(ctx)
			if err != nil {
				if websocket.CloseStatus(err) != transport.CloseRemoved {
					t.Error("ban close", err)
				}
				break
			}
		}
		cancel()
	}
	people, err = f.s.Rooms.Participants(f.ctx)
	if err != nil || len(people) != 0 {
		t.Fatal("ban did not reach every room", len(people), err)
	}
	if _, err := f.s.DB.Exec("DELETE FROM events"); err != nil {
		t.Fatal(err)
	}
	status, data = f.request(t, f.login(t, playerID), "GET", "/api/v1/me/sanctions", nil)
	if status != 200 || !bytes.Contains(data, []byte("permanent explanation")) {
		t.Fatal("expired history erased current explanation", status, string(data))
	}
	f.setRole(t, modID, "player")
	status, _ = f.request(t, mod, "POST", "/api/v1/admin/kick", map[string]string{"target": "guest:" + strings.Repeat("e", 32)})
	if status != 403 {
		t.Fatal("revoked session retained permissions")
	}
}
func (f *fixture) waitOperation(t *testing.T, id string) Operation {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		status, data := f.request(t, f.owner, "GET", "/api/v1/admin/operations/"+id, nil)
		if status != 200 {
			t.Fatal(status, string(data))
		}
		var op Operation
		if err := json.Unmarshal(data, &op); err != nil {
			t.Fatal(err)
		}
		if op.Status != "warning" {
			return op
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("operation never completed")
	return Operation{}
}
func (f *fixture) schedule(t *testing.T, cookie *http.Cookie, id string, c hosting.Config) Operation {
	t.Helper()
	status, data := f.request(t, cookie, "PUT", "/api/v1/admin/rooms/"+id, map[string]any{"config": c, "confirm": true})
	if status != 202 {
		t.Fatal(status, string(data))
	}
	var op Operation
	if err := json.Unmarshal(data, &op); err != nil {
		t.Fatal(err)
	}
	return op
}
func TestRoomPendingRevocationStorageFailureAndRestoration(t *testing.T) {
	f := setup(t)
	f.setRole(t, adminID, "admin")
	admin := f.login(t, adminID)
	id := f.create(t)
	changed := config()
	changed.Name = "Changed"
	op := f.schedule(t, admin, id, changed)
	status, _ := f.request(t, f.owner, "DELETE", "/api/v1/admin/rooms/"+id, map[string]any{"confirm": true})
	if status != 409 {
		t.Fatal("second pending operation accepted", status)
	}
	f.setRole(t, adminID, "player")
	if result := f.waitOperation(t, op.ID); result.Status != "failed" {
		t.Fatal("revoked operation applied", result)
	}
	if f.s.Rooms.Directory().Rooms[0].Info.Name != "Persistent room" {
		t.Fatal("revocation changed live room")
	}
	if _, err := f.s.DB.Exec("CREATE TRIGGER reject_room BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT,'injected'); END"); err != nil {
		t.Fatal(err)
	}
	op = f.schedule(t, f.owner, id, changed)
	if result := f.waitOperation(t, op.ID); result.Status != "failed" {
		t.Fatal("storage failure applied", result)
	}
	if f.s.Rooms.Directory().Rooms[0].Info.Name != "Persistent room" {
		t.Fatal("failed save destroyed match")
	}
	if _, err := f.s.DB.Exec("DROP TRIGGER reject_room"); err != nil {
		t.Fatal(err)
	}
	op = f.schedule(t, f.owner, id, changed)
	if result := f.waitOperation(t, op.ID); result.Status != "applied" {
		t.Fatal(result)
	}
	if f.s.Rooms.Directory().Rooms[0].Info.Name != "Changed" {
		t.Fatal("saved change not installed")
	}
	var storedReason string
	if err := f.s.DB.QueryRow("SELECT reason FROM rooms WHERE id=$1", id).Scan(&storedReason); err != nil || storedReason != "" {
		t.Fatalf("room update retained a reason: %q, %v", storedReason, err)
	}
	if err := f.s.DB.QueryRow("SELECT reason FROM events WHERE target=$1 AND action='room_restart'", id).Scan(&storedReason); err != nil || storedReason != "" {
		t.Fatalf("restart audit retained a reason: %q, %v", storedReason, err)
	}
	status, data := f.request(t, f.owner, "DELETE", "/api/v1/admin/rooms/"+id, map[string]any{"confirm": true})
	if status != 202 {
		t.Fatal(status, string(data))
	}
	if err := json.Unmarshal(data, &op); err != nil {
		t.Fatal(err)
	}
	if result := f.waitOperation(t, op.ID); result.Status != "applied" {
		t.Fatal(result)
	}
	if len(f.s.Rooms.Directory().Rooms) != 0 {
		t.Fatal("closed room retained")
	}
	if err := f.s.Load(f.ctx); err != nil {
		t.Fatal(err)
	}
	if len(f.s.Rooms.Directory().Rooms) != 0 {
		t.Fatal("closed room returned after reload")
	}
}

func TestSlowAdministrationDoesNotBlockLiveSnapshots(t *testing.T) {
	f := setup(t)
	id := f.create(t)
	client := f.connect(t, id, f.login(t, playerID))
	connection, err := f.s.DB.Conn(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			if err := connection.Close(); err != nil {
				t.Error(err)
			}
		}
	}()
	completed := make(chan int, 1)
	go func() {
		status, _ := f.request(t, f.owner, "POST", "/api/v1/admin/kick", map[string]string{"target": "account:" + playerID})
		completed <- status
	}()
	deadline := time.Now().Add(2 * time.Second)
	for f.s.DB.Stats().WaitCount == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if f.s.DB.Stats().WaitCount == 0 {
		t.Fatal("administration did not reach blocked SQL")
	}
	ctx, cancel := context.WithTimeout(f.ctx, 2*time.Second)
	defer cancel()
	snapshots := 0
	for snapshots < 8 {
		var message map[string]any
		if err := readDelivery(ctx, client, &message); err != nil {
			t.Fatal("tick stalled behind SQL", err)
		}
		if message["type"] == "snapshot" {
			snapshots++
		}
	}
	select {
	case <-completed:
		t.Fatal("administration did not wait for SQL")
	default:
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	released = true
	if status := <-completed; status != 200 {
		t.Fatal(status)
	}
}

func TestGuestAccountSeparationAndSanctionExpiryWithoutCleanup(t *testing.T) {
	f := setup(t)
	id := f.create(t)
	guest := "guest:" + strings.Repeat("e", 32)
	status, _ := f.request(t, f.owner, "POST", "/api/v1/admin/sanctions", map[string]any{"target": guest, "minutes": 5, "reason": "guest restriction"})
	if status != 200 {
		t.Fatal(status)
	}
	// The very same browser guest query must not contaminate account admission.
	f.connect(t, id, f.login(t, playerID))
	blocked, err := f.s.blocked(f.ctx, guest)
	if err != nil || !blocked {
		t.Fatal(blocked, err)
	}
	f.s.Now = func() time.Time { return time.Now().Add(6 * time.Minute) }
	blocked, err = f.s.blocked(f.ctx, guest)
	if err != nil || blocked {
		t.Fatal("expired sanction applied", blocked, err)
	}
	var count int
	if err = f.s.DB.QueryRow("SELECT COUNT(*) FROM sanctions").Scan(&count); err != nil || count != 1 {
		t.Fatal("test required retained sanction", count, err)
	}
	f.connect(t, id, nil)
}

func TestCancellationDuringWarningDoesNotSave(t *testing.T) {
	f := setup(t)
	f.s.Warning = time.Second
	id := f.create(t)
	changed := config()
	changed.Name = "Must remain unsaved"
	f.schedule(t, f.owner, id, changed)
	f.cancel()
	time.Sleep(20 * time.Millisecond)
	var raw string
	if err := f.s.DB.QueryRow("SELECT configuration FROM rooms WHERE id=$1", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "Must remain unsaved") {
		t.Fatal("cancelled process saved pending operation")
	}
}

func TestExactOriginRequiredEvenForDiscovery(t *testing.T) {
	f := setup(t)
	id := f.create(t)
	for _, origin := range []string{"", "https://foreign.test", "https" + strings.TrimPrefix(f.server.URL, "http")} {
		target := "ws" + strings.TrimPrefix(f.server.URL, "http") + "/ws?room=" + id + "&info=1"
		c, response, err := websocket.Dial(f.ctx, target, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
		if c != nil {
			_ = c.CloseNow() //nolint:errcheck // Cleanup for an unexpectedly admitted test socket.
		}
		if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
			t.Fatal("origin accepted", origin, err)
		}
	}
}

func TestConcurrentAppointmentsRespectCurrentHierarchy(t *testing.T) {
	f := setup(t)
	f.setRole(t, adminID, "admin")
	admin := f.login(t, adminID)
	results := make(chan int, 2)
	for _, attempt := range []struct {
		cookie *http.Cookie
		role   string
	}{{f.owner, "admin"}, {admin, "moderator"}} {
		go func() {
			status, _ := f.request(t, attempt.cookie, "POST", "/api/v1/admin/roles", map[string]string{"account": playerID, "role": attempt.role})
			results <- status
		}()
	}
	for range 2 {
		if status := <-results; status != 200 && status != 403 {
			t.Fatal(status)
		}
	}
	current, err := role(f.ctx, f.s.DB, "account:"+playerID)
	if err != nil || current != "admin" {
		t.Fatal("stale hierarchy overwrote owner appointment", current, err)
	}
}

func TestExpiredIdentityOffersRecoveryWithoutGuestOrStaffPrivileges(t *testing.T) {
	f := setup(t)
	expired := &http.Cookie{Name: f.owner.Name, Value: "expired-fixture"}
	guest := strings.Repeat("e", 32)
	status, data := f.request(t, expired, "GET", "/api/v1/me?guest="+guest, nil)
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if status != 401 || result["error"] != "authentication_expired" || result["loginAvailable"] != true || result["central"] != f.s.Access.Central() || result["subject"] != nil || result["role"] != nil {
		t.Fatalf("expired identity recovery leaked or lost its boundary: %d %s", status, data)
	}
	if status, _ := f.request(t, expired, "GET", "/api/v1/admin/roles?guest="+guest, nil); status != 401 {
		t.Fatal("expired staff access accepted")
	}
	if status, _ := f.request(t, expired, "GET", "/api/v1/admin/rooms", nil); status != 401 {
		t.Fatal("expired identity accessed administrative directory")
	}
	status, data = f.request(t, nil, "GET", "/api/v1/me?guest="+guest, nil)
	result = map[string]any{}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if status != 200 || result["subject"] != "guest:"+guest || result["role"] != "player" {
		t.Fatal("explicit guest access did not remain separate")
	}
}

func TestRenamePersistsMetadataWithoutInterruptingTheMatch(t *testing.T) {
	f := setup(t)
	status, data := f.request(t, f.owner, "POST", "/api/v1/admin/rooms", map[string]any{"config": config()})
	if status != 201 {
		t.Fatal(status, string(data))
	}
	var directory hosting.Directory
	if err := json.Unmarshal(data, &directory); err != nil {
		t.Fatal(err)
	}
	id := directory.CreatedRoomID
	f.setRole(t, modID, "moderator")
	client := f.connect(t, id, f.login(t, playerID))
	status, _ = f.request(t, f.login(t, modID), "PATCH", "/api/v1/admin/rooms/"+id, map[string]string{"name": "Forbidden"})
	if status != 403 {
		t.Fatal("moderator renamed room", status)
	}
	status, data = f.request(t, f.owner, "PATCH", "/api/v1/admin/rooms/"+id, map[string]string{"name": "  Renamed arena  "})
	if status != 200 {
		t.Fatal(status, string(data))
	}
	if f.s.Rooms.Directory().Rooms[0].Info.Name != "Renamed arena" {
		t.Fatal("live directory did not change")
	}
	var raw string
	if err := f.s.DB.QueryRow("SELECT configuration FROM rooms WHERE id=$1", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var saved hosting.Config
	if err := json.Unmarshal([]byte(raw), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Name != "Renamed arena" || saved.Capacity != config().Capacity || saved.ScoreLimit != config().ScoreLimit {
		t.Fatal("rename changed rules", saved)
	}
	var events int
	if err := f.s.DB.QueryRow("SELECT COUNT(*) FROM events WHERE action='room_rename' AND target=$1", id).Scan(&events); err != nil || events != 1 {
		t.Fatal("missing audit event", events, err)
	}
	people, err := f.s.Rooms.Participants(f.ctx)
	if err != nil || len(people) != 1 || people[0].Room != id {
		t.Fatal("lost participant or room context", people, err)
	}
	if len(f.s.pending) != 0 || len(f.s.operations) != 0 {
		t.Fatal("rename scheduled a restart")
	}
	ctx, cancel := context.WithTimeout(f.ctx, 2*time.Second)
	defer cancel()
	for snapshots := 0; snapshots < 8; {
		var message map[string]any
		if err := readDelivery(ctx, client, &message); err != nil {
			t.Fatal("rename disconnected live client", err)
		}
		if message["type"] == "administration" {
			t.Fatal("rename interrupted the match", message)
		}
		if message["type"] == "snapshot" {
			snapshots++
		}
	}
	if _, err := f.s.DB.Exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected'); END"); err != nil {
		t.Fatal(err)
	}
	status, _ = f.request(t, f.owner, "PATCH", "/api/v1/admin/rooms/"+id, map[string]string{"name": "Must roll back"})
	if status != 503 {
		t.Fatal("storage error hidden", status)
	}
	if err := f.s.DB.QueryRow("SELECT configuration FROM rooms WHERE id=$1", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "Must roll back") || f.s.Rooms.Directory().Rooms[0].Info.Name != "Renamed arena" {
		t.Fatal("failed rename changed state")
	}
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
	if err := json.Unmarshal(frame.Body, target); err != nil {
		return err
	}
	return wsjson.Write(ctx, c, map[string]any{"type": "receipt", "version": gameconfig.ProtocolVersion, "receipt": replication.Receipt{Connection: frame.Connection, Sequence: frame.Sequence, Generation: frame.Generation, EventThrough: frame.EventThrough}})
}

func TestBanOptionalReasonAndRevocationWithoutReason(t *testing.T) {
	blankReason, providedReason := "  ", "  Player report  "
	for _, minutes := range []int{0, 5} {
		for _, note := range []struct {
			name  string
			value *string
			want  string
		}{
			{name: "omitted"},
			{name: "blank", value: &blankReason},
			{name: "provided", value: &providedReason, want: "Player report"},
		} {
			t.Run(fmt.Sprintf("%d/%s", minutes, note.name), func(t *testing.T) {
				f := setup(t)
				target := "guest:" + strings.Repeat("e", 32)
				input := map[string]any{"target": target, "minutes": minutes}
				if note.value != nil {
					input["reason"] = *note.value
				}
				status, data := f.request(t, f.owner, "POST", "/api/v1/admin/sanctions", input)
				if status != 200 {
					t.Fatal(status, string(data))
				}
				var id, why string
				if err := f.s.DB.QueryRow("SELECT id,reason FROM sanctions").Scan(&id, &why); err != nil || why != note.want {
					t.Fatalf("ban reason = %q, error = %v", why, err)
				}
				status, data = f.request(t, f.owner, "DELETE", "/api/v1/admin/sanctions/"+id, nil)
				if status != 200 {
					t.Fatal(status, string(data))
				}
				var revoked int64
				if err := f.s.DB.QueryRow("SELECT revoked_at,revocation_reason FROM sanctions WHERE id=$1", id).Scan(&revoked, &why); err != nil || revoked == 0 || why != "" {
					t.Fatalf("revocation = %d, reason = %q, error = %v", revoked, why, err)
				}
				if err := f.s.DB.QueryRow("SELECT reason FROM events WHERE action='revoke_sanction'").Scan(&why); err != nil || why != "" {
					t.Fatalf("revocation audit reason = %q, error = %v", why, err)
				}
			})
		}
	}
}

func TestBanRejectsOversizedReason(t *testing.T) {
	f := setup(t)
	target := "guest:" + strings.Repeat("e", 32)
	status, data := f.request(t, f.owner, "POST", "/api/v1/admin/sanctions", map[string]any{"target": target, "minutes": 5, "reason": strings.Repeat("x", 501)})
	if status != 403 || !bytes.Contains(data, []byte("reason_too_long")) {
		t.Fatal(status, string(data))
	}
	var count int
	if err := f.s.DB.QueryRow("SELECT COUNT(*) FROM sanctions").Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
}
