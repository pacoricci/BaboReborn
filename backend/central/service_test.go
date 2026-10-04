package central

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"baboreborn/backend/central/storage"
	"baboreborn/backend/identity"
)

func testService(t *testing.T) *Service {
	t.Helper()
	dsn := os.Getenv("BABOREBORN_TEST_POSTGRES")
	if dsn == "" {
		t.Skip("run test:postgres")
	}
	if !strings.Contains(dsn, "/baboreborn_identity_test?") {
		t.Fatal("isolated database required")
	}
	db, err := storage.OpenCentral(context.Background(), t.TempDir(), dsn, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err := db.DB.Exec("TRUNCATE accounts,registered_servers,oidc_flows CASCADE"); err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := identity.NewSigner(key, "test", "https://central.test")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	s := &Service{DB: db.DB, Signer: signer, Keys: jose.JSONWebKeySet{Keys: []jose.JSONWebKey{signer.Public}}, Origin: signer.Issuer, Now: func() time.Time { return now }}
	return s
}
func TestAccountFormsRetainOriginAndRejectOpaqueRequests(t *testing.T) {
	s := testService(t)
	for _, path := range []string{"/auth/logout", "/auth/revoke-all"} {
		cookie, err := s.createSession(context.Background(), "https://accounts.google.com", "form-user")
		if err != nil {
			t.Fatal(err)
		}
		home := httptest.NewRequest("GET", "/account", nil)
		home.AddCookie(&http.Cookie{Name: "central_session", Value: cookie})
		page := httptest.NewRecorder()
		s.Handler().ServeHTTP(page, home)
		if page.Code != http.StatusOK || page.Header().Get("Referrer-Policy") != "same-origin" || !strings.Contains(page.Body.String(), `method="post" action="`+path+`"`) {
			t.Fatal("account form cannot preserve its origin", page.Code)
		}
		for _, origin := range []string{"", "null", "https://foreign.test", s.Origin} {
			request := httptest.NewRequest("POST", path, nil)
			request.AddCookie(&http.Cookie{Name: "central_session", Value: cookie})
			request.Header.Set("Origin", origin)
			response := httptest.NewRecorder()
			s.Handler().ServeHTTP(response, request)
			expected := http.StatusForbidden
			if origin == s.Origin {
				expected = http.StatusSeeOther
			}
			if response.Code != expected {
				t.Fatalf("%s origin %q: %d", path, origin, response.Code)
			}
		}
	}
	keys := httptest.NewRecorder()
	s.Handler().ServeHTTP(keys, httptest.NewRequest("GET", "/identity/v1/keys", nil))
	if keys.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("non-page referrer policy changed")
	}
}

func TestFrontendCachePolicy(t *testing.T) {
	files := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	s := &Service{Files: files}

	tests := []struct {
		path, cacheControl string
	}{
		{"/assets/play-CbmieeX0.js", "public, max-age=31536000, immutable"},
		{"/assets/menu-B-OMJ1Rj.css", "public, max-age=31536000, immutable"},
		{"/assets/lobby-background-jKYS1Vkv.jpg", "public, max-age=31536000, immutable"},
		{"/assets/kit/models/babo.glb", "public, max-age=3600"},
		{"/fonts/anton.ttf", "public, max-age=3600"},
		{"/icons/grenade.svg", "public, max-age=3600"},
		{"/editor.html", "no-store"},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, httptest.NewRequest("GET", test.path, nil))
		if actual := response.Header().Get("Cache-Control"); actual != test.cacheControl {
			t.Errorf("%s: Cache-Control = %q, want %q", test.path, actual, test.cacheControl)
		}
	}
	for _, name := range []string{"/healthz", "/assets/account.js"} {
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, httptest.NewRequest("GET", name, nil))
		if actual := response.Header().Get("Cache-Control"); actual != "no-store" {
			t.Errorf("%s: Cache-Control = %q, want no-store", name, actual)
		}
	}
}
