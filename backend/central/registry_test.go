package central

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
	"baboreborn/backend/server/access"
	"baboreborn/backend/server/administration"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/registration"
	"baboreborn/backend/server/storage"
)

func portalRequest(t *testing.T, s *Service, cookie, method, path string, body any) (int, []byte) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", s.Origin)
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: "central_session", Value: cookie})
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}
func accountCookie(t *testing.T, s *Service, subject string) (string, string) {
	t.Helper()
	cookie, err := s.createSession(context.Background(), "https://accounts.google.com", subject)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: "central_session", Value: cookie})
	session, err := s.session(r)
	if err != nil {
		t.Fatal(err)
	}
	return cookie, session.Account
}
func management(t *testing.T, s *Service, cookie, method, path string, body any) (registry.Descriptor, string) {
	t.Helper()
	status, b := portalRequest(t, s, cookie, method, path, body)
	if status != 200 {
		t.Fatalf("%s %s: %d %s", method, path, status, b)
	}
	var result struct {
		Server    registry.Descriptor `json:"server"`
		Code      string              `json:"code"`
		ExpiresAt *time.Time          `json:"expiresAt"`
	}
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	if result.Code != "" {
		var stored time.Time
		if err := s.DB.QueryRowContext(context.Background(), "SELECT expires_at FROM pairing_codes WHERE credential_hash=$1", identity.Hash(result.Code)).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if result.ExpiresAt == nil || !result.ExpiresAt.Equal(stored) || result.ExpiresAt.Location() != time.UTC {
			t.Fatalf("pairing expiry must match storage in UTC: response %v, stored %v", result.ExpiresAt, stored)
		}
	} else if result.ExpiresAt != nil {
		t.Fatal("pairing expiry returned without a code")
	}
	return result.Server, result.Code
}

type installation struct {
	client *registration.Client
	local  *storage.Local
	admin  *administration.Service
	auth   *access.Manager
}

func makeInstallation(t *testing.T, s *Service, code string) *installation {
	t.Helper()
	ctx := context.Background()
	directory := t.TempDir()
	local, err := storage.OpenLocal(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := local.Close(); err != nil {
			t.Error(err)
		}
	})
	file := filepath.Join(directory, "pairing")
	if err = os.WriteFile(file, []byte(code), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := registration.Open(ctx, local.DB, s.Origin, file, true, compatibility.Current())
	if err != nil {
		t.Fatal(err)
	}
	auth, err := access.New(access.Config{Origin: s.Origin, Central: s.Origin, Development: true, Association: c.Snapshot})
	if err != nil {
		t.Fatal(err)
	}
	rooms := hosting.New(ctx, nil, nil, 8)
	admin := administration.New(ctx, local.DB, auth, rooms)
	c.Apply = admin.ApplyAssociation
	c.Verify = auth.VerifyRegistry
	if err = auth.RefreshKeys(ctx); err != nil {
		t.Fatal(err)
	}
	return &installation{c, local, admin, auth}
}
func TestRegistryAssociationTransferRecoveryAndRemoval(t *testing.T) {
	s := testService(t)
	s.Development = true
	center := httptest.NewServer(s.Handler())
	defer center.Close()
	s.Origin = center.URL
	s.Signer.Issuer = s.Origin
	s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
	var mu sync.RWMutex
	var handler = http.NotFoundHandler()
	game := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		h := handler
		mu.RUnlock()
		h.ServeHTTP(w, r)
	}))
	defer game.Close()
	owner, ownerID := accountCookie(t, s, "owner")
	recipient, recipientID := accountCookie(t, s, "recipient")
	d, code := management(t, s, owner, "POST", "/api/v1/manage/servers", map[string]any{"name": "Community", "region": "Europe", "origin": game.URL})
	initial := makeInstallation(t, s, code)
	mu.Lock()
	handler = initial.auth.CORS(initial.client.Handler(initial.admin.Handler(http.NotFoundHandler())))
	mu.Unlock()
	if err := initial.client.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	d, err := s.readServer(context.Background(), s.DB, d.ID, false)
	if err != nil || !d.Online || d.Owner != ownerID {
		t.Fatal(d, err)
	}
	var localOwner string
	if err = initial.local.DB.QueryRow("SELECT owner_id FROM association").Scan(&localOwner); err != nil || localOwner != ownerID {
		t.Fatal(localOwner, err)
	}
	// Re-open the client from durable state without the pairing file.
	restarted, err := registration.Open(context.Background(), initial.local.DB, s.Origin, "", true, compatibility.Current())
	if err != nil {
		t.Fatal(err)
	}
	restarted.Apply = initial.admin.ApplyAssociation
	restarted.Verify = initial.auth.VerifyRegistry
	if err = restarted.Step(context.Background()); err != nil {
		t.Fatal("restart", err)
	}
	if restarted.Snapshot().ID != d.ID {
		t.Fatal("restart changed identity")
	}
	// A consumed code is bound to its original installation, even before another nonce is issued.
	_, otherKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.registryOperation(context.Background(), registry.Public(otherKey), registry.Request{Action: "claim", Code: code}); err == nil {
		t.Fatal("code reused by another installation")
	}
	status, raw := portalRequest(t, s, owner, "POST", "/identity/v1/access", map[string]string{"serverId": d.ID})
	if status != 200 {
		t.Fatal(status, string(raw))
	}
	var tokens identity.Tokens
	if err = json.Unmarshal(raw, &tokens); err != nil {
		t.Fatal(err)
	}
	if _, err = identity.Verify(tokens.Proof, s.Origin, "another-server", s.Keys, s.now()); err == nil {
		t.Fatal("proof crossed audiences")
	}
	// A failed address edit preserves the verified endpoint and its live listing.
	d, _ = management(t, s, owner, "PATCH", "/api/v1/manage/servers/"+d.ID, map[string]any{"revision": d.Revision, "name": d.Name, "region": d.Region, "origin": "http://127.0.0.1:1"})
	if err = initial.client.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	d, err = s.readServer(context.Background(), s.DB, d.ID, false)
	if err != nil || d.Origin != game.URL || !d.Online || d.Error != "candidate_origin_verification_failed" {
		t.Fatal(d, err)
	}
	d, _ = management(t, s, owner, "PATCH", "/api/v1/manage/servers/"+d.ID, map[string]any{"revision": d.Revision, "name": d.Name, "region": d.Region, "origin": game.URL})
	// Invitations can be declined, cancelled or expire without changing ownership.
	d, _ = management(t, s, owner, "POST", "/api/v1/manage/servers/"+d.ID+"/transfer", map[string]any{"revision": d.Revision, "account": recipientID})
	d, _ = management(t, s, recipient, "POST", "/api/v1/manage/servers/"+d.ID+"/reject", map[string]any{"revision": d.Revision})
	d, _ = management(t, s, owner, "POST", "/api/v1/manage/servers/"+d.ID+"/transfer", map[string]any{"revision": d.Revision, "account": recipientID})
	d, _ = management(t, s, owner, "POST", "/api/v1/manage/servers/"+d.ID+"/cancel-transfer", map[string]any{"revision": d.Revision})
	d, _ = management(t, s, owner, "POST", "/api/v1/manage/servers/"+d.ID+"/transfer", map[string]any{"revision": d.Revision, "account": recipientID})
	clock := s.now()
	s.Now = func() time.Time { return clock.Add(24 * time.Hour) }
	if status, _ = portalRequest(t, s, recipient, "POST", "/api/v1/manage/servers/"+d.ID+"/accept", map[string]any{"revision": d.Revision}); status != 403 {
		t.Fatal("expired transfer accepted", status)
	}
	s.Now = func() time.Time { return clock }
	d, _ = management(t, s, owner, "POST", "/api/v1/manage/servers/"+d.ID+"/transfer", map[string]any{"revision": d.Revision, "account": recipientID})
	d, _ = management(t, s, recipient, "POST", "/api/v1/manage/servers/"+d.ID+"/accept", map[string]any{"revision": d.Revision})
	if d.Online || !d.TransferAccepted || d.Owner != ownerID {
		t.Fatal("transfer completed without server", d)
	}
	if err = initial.client.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	d, err = s.readServer(context.Background(), s.DB, d.ID, false)
	if err != nil || !d.Online || d.Owner != recipientID || d.TransferAccepted {
		t.Fatal(d, err)
	}
	if err = initial.local.DB.QueryRow("SELECT owner_id FROM association").Scan(&localOwner); err != nil || localOwner != recipientID {
		t.Fatal(localOwner, err)
	}
	var count int
	if err = initial.local.DB.QueryRow("SELECT count(*) FROM roles WHERE account_id=$1", ownerID).Scan(&count); err != nil || count != 0 {
		t.Fatal("previous owner retained privileges", err)
	}
	if status, _ = portalRequest(t, s, owner, "DELETE", "/api/v1/manage/servers/"+d.ID, nil); status != 403 {
		t.Fatal("old owner could remove server", status)
	}
	d, recovery := management(t, s, recipient, "POST", "/api/v1/manage/servers/"+d.ID+"/recover", map[string]any{"revision": d.Revision})
	replacement := makeInstallation(t, s, recovery)
	mu.Lock()
	handler = replacement.auth.CORS(replacement.client.Handler(replacement.admin.Handler(http.NotFoundHandler())))
	mu.Unlock()
	if err = replacement.client.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if replacement.client.Snapshot().ID != d.ID || replacement.client.Snapshot().PublicKey == initial.client.Snapshot().PublicKey {
		t.Fatal("recovery lost identity or reused key")
	}
	if err = initial.client.Step(context.Background()); err == nil || err.Error() != "installation_revoked" {
		t.Fatal("old installation not revoked", err)
	}
	// Revocation survives restart without requiring another network response.
	revoked, err := registration.Open(context.Background(), initial.local.DB, s.Origin, "", true, compatibility.Current())
	if err != nil {
		t.Fatal(err)
	}
	if revoked.Snapshot().Status != "removed" {
		t.Fatal("revocation not persisted")
	}
	if err = revoked.Step(context.Background()); err == nil || err.Error() != "installation_revoked" {
		t.Fatal("revoked restart did not stop", err)
	}
	d, _ = management(t, s, recipient, "DELETE", "/api/v1/manage/servers/"+d.ID, nil)
	if err = replacement.client.Step(context.Background()); err != nil {
		t.Fatal(err)
	}
	if replacement.client.Snapshot().Status != "removed" {
		t.Fatal("removal not persisted")
	}
	if status, _ = portalRequest(t, s, recipient, "POST", "/identity/v1/access", map[string]string{"serverId": d.ID}); status != 409 {
		t.Fatal("removed server got fresh access", status)
	}
	if status, _ = portalRequest(t, s, "", "GET", "/api/v1/servers/"+d.ID, nil); status != 404 {
		t.Fatal("removed entry resolved", status)
	}
}
func TestRegistryCodesExpireRegenerateAndNoncesCannotReplay(t *testing.T) {
	s := testService(t)
	cookie, _ := accountCookie(t, s, "owner")
	d, first := management(t, s, cookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Server", "region": "EU", "origin": "https://game.example.org"})
	if status, _ := portalRequest(t, s, cookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Duplicate", "region": "EU", "origin": "https://GAME.example.org:443/"}); status != 409 {
		t.Fatal("browser-equivalent origins registered twice", status)
	}
	_, second := management(t, s, cookie, "POST", "/api/v1/manage/servers/"+d.ID+"/code", map[string]any{"revision": d.Revision})
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.registryOperation(context.Background(), registry.Public(key), registry.Request{Action: "claim", Code: first}); err == nil {
		t.Fatal("regenerated code remained valid")
	}
	now := s.now()
	s.Now = func() time.Time { return now.Add(registry.PairingLifetime) }
	if _, err = s.registryOperation(context.Background(), registry.Public(key), registry.Request{Action: "claim", Code: second}); err == nil {
		t.Fatal("expired code accepted")
	}
	request := signedNonceRequest(t, key, registry.NonceRequest{Purpose: "claim", Code: second})
	status, _, b := issueNonce(t, s, request)
	if status != 409 {
		t.Fatal("expired code received a nonce", status, string(b))
	}
	// Issue shortly before expiry so the code lapses while its nonce is still live.
	s.Now = func() time.Time { return now.Add(registry.PairingLifetime - 30*time.Second) }
	status, nonce, b := issueNonce(t, s, request)
	if status != 200 {
		t.Fatal(status, string(b))
	}
	s.Now = func() time.Time { return now.Add(registry.PairingLifetime) }
	packet, err := registry.Sign(key, registry.Request{Action: "claim", Nonce: nonce, Code: second})
	if err != nil {
		t.Fatal(err)
	}
	for i, expected := range []int{409, 401} {
		status, b = portalRequest(t, s, "", "POST", "/registry/v1/request", packet)
		if status != expected {
			t.Fatal(i, status, string(b))
		}
	}
	for _, path := range []string{"/identity/v99/keys", "/identity/v1/authorize", "/identity/v1/renew"} {
		status, _ = portalRequest(t, s, "", "GET", path, nil)
		if status != 426 {
			t.Fatal("unsupported identity route admitted", path, status)
		}
	}
	// No secret is rendered by a later owner-list request.
	_, b = portalRequest(t, s, cookie, "GET", "/api/v1/manage/servers", nil)
	if strings.Contains(string(b), first) || strings.Contains(string(b), second) {
		t.Fatal("pairing secret persisted in response")
	}
}

type lostRegistryResponse struct {
	action string
	once   bool
}

func (l *lostRegistryResponse) RoundTrip(r *http.Request) (*http.Response, error) {
	lose := false
	if r.URL.Path == "/registry/v1/request" && !l.once {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			return nil, err
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var packet registry.Packet
		var request registry.Request
		if json.Unmarshal(raw, &packet) == nil && packet.Verify(&request) == nil && request.Action == l.action {
			lose = true
			l.once = true
		}
	}
	response, err := http.DefaultTransport.RoundTrip(r)
	if err == nil && lose {
		_, _ = io.Copy(io.Discard, response.Body) //nolint:errcheck // Deliberately discard a completed response.
		_ = response.Body.Close()                 //nolint:errcheck // Simulated network loss.
		return nil, fmt.Errorf("simulated_lost_response")
	}
	return response, err
}
func TestRegistryRetriesAcrossDurableBoundaries(t *testing.T) {
	for _, failure := range []string{"claim", "apply", "ack"} {
		t.Run(failure, func(t *testing.T) {
			s := testService(t)
			s.Development = true
			center := httptest.NewServer(s.Handler())
			defer center.Close()
			s.Origin = center.URL
			s.Signer.Issuer = s.Origin
			s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
			var current *registration.Client
			var mu sync.RWMutex
			game := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.RLock()
				c := current
				mu.RUnlock()
				c.Handler(http.NotFoundHandler()).ServeHTTP(w, r)
			}))
			defer game.Close()
			cookie, _ := accountCookie(t, s, "owner")
			d, code := management(t, s, cookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Retry", "region": "EU", "origin": game.URL})
			installed := makeInstallation(t, s, code)
			mu.Lock()
			current = installed.client
			mu.Unlock()
			if failure == "apply" {
				installed.client.Apply = func(context.Context, registry.Descriptor, ed25519.PrivateKey) error {
					return fmt.Errorf("simulated_disk_failure")
				}
			} else {
				installed.client.HTTP.Transport = &lostRegistryResponse{action: failure}
			}
			if err := installed.client.Step(context.Background()); err == nil {
				t.Fatal("failure not injected")
			}
			before, err := s.readServer(context.Background(), s.DB, d.ID, false)
			if err != nil {
				t.Fatal(err)
			}
			if before.Online && failure != "ack" {
				t.Fatal("published before durable application")
			}
			// A new client reads only SQLite state, as it would after a process restart.
			restarted, err := registration.Open(context.Background(), installed.local.DB, s.Origin, "", true, compatibility.Current())
			if err != nil {
				t.Fatal(err)
			}
			restarted.Apply = installed.admin.ApplyAssociation
			restarted.Verify = installed.auth.VerifyRegistry
			mu.Lock()
			current = restarted
			mu.Unlock()
			if err = restarted.Step(context.Background()); err != nil {
				t.Fatal(err)
			}
			after, err := s.readServer(context.Background(), s.DB, d.ID, false)
			if err != nil || !after.Online || after.Revision != before.Revision || after.OperationID != before.OperationID || after.PublicKey != before.PublicKey {
				t.Fatal("retry duplicated association", before, after, err)
			}
			var events int
			if err = installed.local.DB.QueryRow("SELECT count(*) FROM events WHERE action='association'").Scan(&events); err != nil || events != 1 {
				t.Fatal("duplicate audit", events, err)
			}
		})
	}
}

func TestRegistryConcurrentClaimsAndPresence(t *testing.T) {
	s := testService(t)
	s.Development = true
	s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
	keys := map[string]ed25519.PrivateKey{}
	for i := 0; i < 2; i++ {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		keys[registry.Public(key)] = key
	}
	// Both claimants can answer the address challenge; only one may consume the code.
	game := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := keys[r.URL.Query().Get("key")]
		packet, err := registry.Sign(key, registry.Probe{Nonce: r.URL.Query().Get("nonce"), Compatibility: compatibility.Current()})
		if err != nil {
			t.Error(err)
			return
		}
		if r.URL.Path == "/ws" {
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				return
			}
			defer conn.CloseNow() //nolint:errcheck // Test cleanup.
			raw, err := json.Marshal(packet)
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Write(r.Context(), websocket.MessageText, raw) //nolint:errcheck // Probe may be cancelled after a competing claim.
		} else {
			identity.JSON(w, 200, packet)
		}
	}))
	defer game.Close()
	cookie, _ := accountCookie(t, s, "owner")
	d, code := management(t, s, cookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Concurrent", "region": "EU", "origin": game.URL})
	results := make(chan error, 2)
	for key := range keys {
		go func() {
			_, err := s.registryOperation(context.Background(), key, registry.Request{Action: "claim", Code: code})
			results <- err
		}()
	}
	successes := 0
	for i := 0; i < 2; i++ {
		if <-results == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatal("claimants admitted", successes)
	}
	d, err := s.readServer(context.Background(), s.DB, d.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.registryOperation(context.Background(), d.PublicKey, registry.Request{Action: "ack", ServerID: d.ID, Revision: d.Revision}); err != nil {
		t.Fatal(err)
	}
	now := s.now()
	s.Now = func() time.Time { return now.Add(registry.Presence) }
	offline, err := s.readServer(context.Background(), s.DB, d.ID, false)
	if err != nil || offline.Online || offline.Owner != d.Owner || offline.PublicKey != d.PublicKey {
		t.Fatal(offline, err)
	}
	s.Now = func() time.Time { return now }
	s.VerifierRegistry.Expected.Protocol++
	incompatible, err := s.readServer(context.Background(), s.DB, d.ID, false)
	if err != nil || incompatible.Online || incompatible.Compatible {
		t.Fatal("old compatibility verdict survived portal upgrade", incompatible, err)
	}
}
