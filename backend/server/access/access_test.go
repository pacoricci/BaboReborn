package access

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"baboreborn/backend/identity"
)

func TestPortalProofAudienceExpiryAndGuestIsolation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := identity.NewSigner(key, "test", "https://portal.test")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	proof, err := signer.Issue(strings.Repeat("a", 32), "server-a", "session", now, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, server := range []string{"server-a", "server-b"} {
		m, err := New(Config{Server: server, Origin: signer.Issuer, Central: signer.Issuer})
		if err != nil {
			t.Fatal(err)
		}
		m.keys = jose.JSONWebKeySet{Keys: []jose.JSONWebKey{signer.Public}}
		m.Now = func() time.Time { return now }
		r := httptest.NewRequest("GET", "/api/v1/me", nil)
		r.Header.Set("Authorization", "Bearer "+proof.Proof)
		r.Header.Set("X-Guest-ID", strings.Repeat("b", 32))
		who, err := m.Current(r)
		if server == "server-b" {
			if err == nil {
				t.Fatal("cross-server proof accepted")
			}
			continue
		}
		if err != nil || who.Subject != "account:"+strings.Repeat("a", 32) {
			t.Fatal(who, err)
		}
		m.Now = func() time.Time { return now.Add(identity.ProofLifetime) }
		if _, err = m.Current(r); err == nil {
			t.Fatal("expired proof became guest")
		}
		r.Header.Del("Authorization")
		who, err = m.Current(r)
		if err != nil || who.Subject != "guest:"+strings.Repeat("b", 32) {
			t.Fatal(who, err)
		}
		m.Maintain(context.Background())
		if m.ValidSession("session", "account:"+strings.Repeat("a", 32)) {
			t.Fatal("expired session retained")
		}
	}
}
func TestCORSRequiresExactPortalWithoutCookies(t *testing.T) {
	m, err := New(Config{Server: "a", Origin: "https://portal.test", Central: "https://portal.test"})
	if err != nil {
		t.Fatal(err)
	}
	handler := m.CORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	plain := httptest.NewRecorder()
	handler.ServeHTTP(plain, httptest.NewRequest("GET", "/content/v1/files/test.png", nil))
	if plain.Header().Get("Vary") != "Origin" {
		t.Fatal("non-CORS response can poison content cache")
	}
	for _, origin := range []string{"https://portal.test", "https://foreign.test", "null", ""} {
		r := httptest.NewRequest("OPTIONS", "/api/v1/roles", nil)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		expected := 403
		if origin == m.Origin() {
			expected = 204
		}
		if w.Code != expected || w.Header().Get("Access-Control-Allow-Credentials") != "" {
			t.Fatal(origin, w.Code, w.Header())
		}
	}
}
