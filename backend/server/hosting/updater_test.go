package hosting

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
	"baboreborn/backend/server/transport"
)

const testUpdaterToken = "private-test-updater-token"

func updaterRequest(m *Manager, method string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "/maintenance/drain", nil)
	r.Header.Set("Authorization", "Bearer "+testUpdaterToken)
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r)
	return w
}

func updaterRoom(t *testing.T, m *Manager, id string) {
	t.Helper()
	w := match.MustNew(testcontent.Map("yard"))
	if _, err := w.AddBot(bots.NewSimple(bots.Standard(), 1), navigation.New(w.Geometry.Grid)); err != nil {
		t.Fatal(err)
	}
	if err := m.Install(id, transport.New(w, 4, nil)); err != nil {
		t.Fatal(err)
	}
}

func updaterSocketURL(server *httptest.Server, room string) string {
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?room=" + room + "&v=" + strconv.Itoa(gameconfig.ProtocolVersion) + "&profile=" + compatibility.GameProfile()
}

func TestUpdaterRequiresPrivateAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name, method, token, origin string
		status                      int
	}{
		{"anonymous", http.MethodPost, "", "", http.StatusForbidden},
		{"wrong_token", http.MethodPost, "wrong", "", http.StatusForbidden},
		{"browser_origin", http.MethodPost, testUpdaterToken, "https://portal.example", http.StatusForbidden},
		{"unsupported_method", http.MethodGet, testUpdaterToken, "", http.StatusMethodNotAllowed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := New(context.Background(), nil, nil, 1)
			m.SetUpdaterToken(testUpdaterToken)
			r := httptest.NewRequest(tc.method, "/maintenance/drain", nil)
			r.Header.Set("Authorization", "Bearer "+tc.token)
			r.Header.Set("Origin", tc.origin)
			w := httptest.NewRecorder()
			m.ServeHTTP(w, r)
			if w.Code != tc.status || m.draining {
				t.Fatalf("unauthorized drain = %d, draining %v", w.Code, m.draining)
			}
		})
	}
	m := New(context.Background(), nil, nil, 1)
	if w := updaterRequest(m, http.MethodPost); w.Code != http.StatusForbidden {
		t.Fatalf("unconfigured updater = %d", w.Code)
	}
}

func TestUpdaterDrainKeepsOccupiedRoomsOpenAndBlocksLateJoins(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m := New(ctx, nil, nil, 3)
	m.SetUpdaterToken(testUpdaterToken)
	updaterRoom(t, m, "empty")
	updaterRoom(t, m, "occupied")
	server := httptest.NewServer(m)
	defer server.Close()
	conn := roomTestSocket(t, ctx, updaterSocketURL(server, "occupied"))
	roomTestWelcome(t, ctx, conn)
	if got := m.humans(); got != 1 {
		t.Fatalf("humans immediately after welcome = %d", got)
	}
	if w := updaterRequest(m, http.MethodPost); w.Code != http.StatusConflict {
		t.Fatalf("occupied drain = %d %s", w.Code, w.Body)
	}
	other := roomTestSocket(t, ctx, updaterSocketURL(server, "empty"))
	roomTestWelcome(t, ctx, other) // A refused drain must keep every room open.
	for _, c := range []*websocket.Conn{conn, other} {
		if err := c.Close(websocket.StatusNormalClosure, ""); err != nil {
			t.Fatal(err)
		}
	}
	for m.humans() != 0 {
		select {
		case <-ctx.Done():
			t.Fatal("humans remained after disconnect")
		case <-time.After(time.Millisecond):
		}
	}
	if w := updaterRequest(m, http.MethodPost); w.Code != http.StatusNoContent {
		t.Fatalf("empty drain with bots = %d %s", w.Code, w.Body)
	}
	updaterRoom(t, m, "new") // New rooms must inherit the host's admission gate.
	for _, room := range []string{"empty", "occupied", "new"} {
		late := roomTestSocket(t, ctx, updaterSocketURL(server, room))
		roomTestClose(t, ctx, late, websocket.StatusPolicyViolation, "server_updating")
	}
	if w := updaterRequest(m, http.MethodDelete); w.Code != http.StatusNoContent {
		t.Fatalf("resume = %d %s", w.Code, w.Body)
	}
	resumed := roomTestSocket(t, ctx, updaterSocketURL(server, "occupied"))
	roomTestWelcome(t, ctx, resumed)
}

func TestUpdaterDrainRejectsAdmissionAlreadyInFlight(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m := New(ctx, nil, nil, 1)
	m.SetUpdaterToken(testUpdaterToken)
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	m.SetAdmission(func(_ *http.Request, join func(transport.Identity) error) error {
		close(entered)
		<-release
		return join(transport.Identity{})
	})
	updaterRoom(t, m, "one")
	server := httptest.NewServer(m)
	defer server.Close()
	conn := roomTestSocket(t, ctx, updaterSocketURL(server, "one"))
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("admission did not enter policy")
	}
	if w := updaterRequest(m, http.MethodPost); w.Code != http.StatusNoContent {
		t.Fatalf("drain before admission = %d %s", w.Code, w.Body)
	}
	close(release)
	roomTestClose(t, ctx, conn, websocket.StatusPolicyViolation, "server_updating")
	if m.humans() != 0 {
		t.Fatal("draining host admitted a human")
	}
}
