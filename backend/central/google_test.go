package central

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"golang.org/x/oauth2"

	"baboreborn/backend/identity"
)

func TestGoogleAuthorizationCodePKCEStateNonce(t *testing.T) {
	s := testService(t)
	s.Development = true
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signing, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "google-test"))
	if err != nil {
		t.Fatal(err)
	}
	var providerURL, nonce, challenge string
	wrongNonce := true
	exchanges := 0
	providerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			identity.JSON(w, 200, map[string]any{"issuer": providerURL, "authorization_endpoint": providerURL + "/authorize", "token_endpoint": providerURL + "/token", "jwks_uri": providerURL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/keys":
			identity.JSON(w, 200, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "google-test", Algorithm: "RS256", Use: "sig"}}})
		case "/token":
			exchanges++
			if err := r.ParseForm(); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			if r.Form.Get("grant_type") != "authorization_code" || identity.Challenge(r.Form.Get("code_verifier")) != challenge {
				t.Error("PKCE verifier missing or wrong")
				w.WriteHeader(400)
				return
			}
			returnedNonce := nonce
			if wrongNonce {
				returnedNonce = "wrong"
			}
			token, err := jwt.Signed(signing).Claims(map[string]any{"iss": providerURL, "sub": "google-stable-subject", "aud": "google-client", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(), "nonce": returnedNonce}).Serialize()
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			identity.JSON(w, 200, map[string]any{"access_token": "google-token-stays-central", "token_type": "Bearer", "expires_in": 3600, "id_token": token})
		default:
			w.WriteHeader(404)
		}
	}))
	defer providerServer.Close()
	providerURL = providerServer.URL
	provider, err := oidc.NewProvider(context.Background(), providerURL)
	if err != nil {
		t.Fatal(err)
	}
	s.OAuth = oauth2.Config{ClientID: "google-client", ClientSecret: "test-only", RedirectURL: s.Origin + "/auth/callback", Endpoint: provider.Endpoint(), Scopes: []string{oidc.ScopeOpenID}}
	s.Verifier = provider.Verifier(&oidc.Config{ClientID: "google-client", SupportedSigningAlgs: []string{"RS256"}})
	for attempt := 0; attempt < 2; attempt++ {
		start := httptest.NewRecorder()
		s.Handler().ServeHTTP(start, httptest.NewRequest("GET", "/auth/login", nil))
		if start.Code != 303 {
			t.Fatal(start.Code, start.Body.String())
		}
		googleURL, err := url.Parse(start.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		params := googleURL.Query()
		nonce = params.Get("nonce")
		challenge = params.Get("code_challenge")
		if params.Get("code_challenge_method") != "S256" || nonce == "" {
			t.Fatal("missing OIDC protection")
		}
		cookies := start.Result().Cookies()
		if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
			t.Fatal("flow cookie policy")
		}
		if _, _, err := s.cleanupExpired(context.Background()); err != nil {
			t.Fatal(err)
		}
		callback := httptest.NewRequest("GET", "/auth/callback?code=google-code&state="+params.Get("state"), nil)
		rejected := httptest.NewRecorder()
		s.Handler().ServeHTTP(rejected, callback)
		if rejected.Code != 400 {
			t.Fatal("missing browser binding accepted")
		}
		callback.AddCookie(cookies[0])
		result := httptest.NewRecorder()
		s.Handler().ServeHTTP(result, callback)
		if wrongNonce {
			if result.Code != 401 {
				t.Fatal("wrong nonce accepted", result.Code)
			}
			wrongNonce = false
		} else {
			if result.Code != 303 {
				t.Fatal(result.Code, result.Body.String())
			}
			if result.Header().Get("Location") != "/account" {
				t.Fatal("portal sign-in did not return to the account page")
			}
			found := false
			for _, cookie := range result.Result().Cookies() {
				if cookie.Name == "central_session" {
					found = true
					if !cookie.HttpOnly || cookie.MaxAge != int(identity.SessionLifetime.Seconds()) {
						t.Fatal("session cookie policy")
					}
				}
			}
			if !found {
				t.Fatal("missing central session")
			}
		}
		replay := httptest.NewRecorder()
		s.Handler().ServeHTTP(replay, callback)
		if replay.Code != 400 {
			t.Fatal("state replay accepted")
		}
	}
	if exchanges != 2 {
		t.Fatal("unexpected Google token exchanges", exchanges)
	}
	var count int
	if err := s.DB.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&count); err != nil || count != 1 {
		t.Fatal("unexpected accounts", count, err)
	}
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/identity/v1/keys", nil))
	var keys jose.JSONWebKeySet
	if err := json.Unmarshal(response.Body.Bytes(), &keys); err != nil || len(keys.Keys) != 1 {
		t.Fatal("public keys", err)
	}
}
