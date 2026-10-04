// Devcentral is a loopback-only OIDC fixture, excluded from production binaries.
// It exercises the real central callback and SQL path without Google credentials.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"golang.org/x/oauth2"

	"baboreborn/backend/central"
	"baboreborn/backend/central/storage"
	"baboreborn/backend/compatibility"
	"baboreborn/backend/content"
	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
	"baboreborn/backend/web"
	bundledcontent "baboreborn/content"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() (err error) {
	directory := flag.String("data-dir", ".data/identity-dev/central", "Fixture data directory")
	serverHost := flag.String("server-host", "127.0.0.1", "Loopback game frontend hostname")
	offset := flag.Int("port-offset", 0, "Offset all loopback fixture ports for an isolated parallel stack")
	contentDir := flag.String("content-dir", "", "Additional central maps, skins and themes")
	fileOrigin := flag.String("content-origin", "", "Public CDN origin for immutable content; empty serves directly")
	flag.Parse()
	if *offset < 0 || *offset > 47441 {
		return fmt.Errorf("port-offset must be 0..47441")
	}
	if *serverHost != "127.0.0.1" && *serverHost != "localhost" {
		log.Fatal("Server host must be loopback")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	local, err := storage.OpenCentral(ctx, *directory, os.Getenv("CENTRAL_DATABASE_URL"), true)
	if err != nil {
		return err
	}
	defer func() {
		if e := local.Close(); err == nil {
			err = e
		}
	}()
	origin := fmt.Sprintf("http://127.0.0.1:%d", 18090+*offset)
	google := fmt.Sprintf("http://127.0.0.1:%d", 18093+*offset)
	fixtureAccounts := []string{"Owner", "Admin", "Moderator", "Player", "Deletion"}
	for i, name := range fixtureAccounts {
		id := strings.Repeat(fmt.Sprint(i+1), 32)
		if _, err = local.DB.ExecContext(ctx, "INSERT INTO accounts VALUES($1,$2) ON CONFLICT DO NOTHING", id, time.Now()); err != nil {
			return err
		}
		if _, err = local.DB.ExecContext(ctx, "INSERT INTO external_identities VALUES($1,$2,$3) ON CONFLICT DO NOTHING", google, name, id); err != nil {
			return err
		}
	}
	signer, err := identity.LoadSigner(filepath.Join(*directory, "signing.pem"), "initial", origin)
	if err != nil {
		return err
	}
	keys, err := identity.LoadKeys(filepath.Join(*directory, "keys.json"))
	if err != nil {
		return err
	}
	googleKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return err
	}
	googleSigner, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: googleKey}, (&jose.SignerOptions{}).WithHeader("kid", "fixture"))
	if err != nil {
		return err
	}
	type flow struct{ subject, nonce, challenge string }
	codes := map[string]flow{}
	var mu sync.Mutex
	googleHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			identity.JSON(w, http.StatusOK, map[string]any{"issuer": google, "authorization_endpoint": google + "/authorize", "token_endpoint": google + "/token", "jwks_uri": google + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/keys":
			identity.JSON(w, http.StatusOK, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &googleKey.PublicKey, KeyID: "fixture", Algorithm: "RS256", Use: "sig"}}})
		case "/authorize":
			q := r.URL.Query()
			if q.Get("redirect_uri") != origin+"/auth/callback" || q.Get("client_id") != "local-fixture" || q.Get("code_challenge_method") != "S256" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			subject := q.Get("fixture_account")
			if subject == "" {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				if _, err := fmt.Fprint(w, "<!doctype html><title>Local OIDC fixture</title><h1>Local test identity</h1><p>This is a loopback test provider, not Google.</p>"); err != nil {
					return
				}
				for _, name := range fixtureAccounts {
					q.Set("fixture_account", name)
					if _, err := fmt.Fprintf(w, "<p><a href=\"/authorize?%s\">%s</a></p>", strings.ReplaceAll(q.Encode(), "&", "&amp;"), name); err != nil {
						return
					}
				}
				return
			}
			if !slices.Contains(fixtureAccounts, subject) {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			code := identity.Random()
			mu.Lock()
			codes[code] = flow{subject, q.Get("nonce"), q.Get("code_challenge")}
			mu.Unlock()
			target := origin + "/auth/callback?" + url.Values{"code": {code}, "state": {q.Get("state")}}.Encode()
			http.Redirect(w, r, target, http.StatusSeeOther)
		case "/token":
			if err := r.ParseForm(); err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			mu.Lock()
			f, ok := codes[r.Form.Get("code")]
			delete(codes, r.Form.Get("code"))
			mu.Unlock()
			if !ok || identity.Challenge(r.Form.Get("code_verifier")) != f.challenge {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			token, err := jwt.Signed(googleSigner).Claims(map[string]any{"iss": google, "sub": f.subject, "aud": "local-fixture", "nonce": f.nonce, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix()}).Serialize()
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			identity.JSON(w, http.StatusOK, map[string]any{"access_token": "fixture-only", "token_type": "Bearer", "id_token": token, "expires_in": 3600})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	providerServer := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", 18093+*offset), Handler: googleHandler, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := providerServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Print(err)
			cancel()
		}
	}()
	defer func() {
		if e := providerServer.Close(); err == nil {
			err = e
		}
	}()
	var provider *oidc.Provider
	for range 30 {
		provider, err = oidc.NewProvider(ctx, google)
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	if err != nil {
		return err
	}
	cosmetics, err := content.Load(bundledcontent.Files, *contentDir)
	if err != nil {
		return err
	}
	if err = cosmetics.SetFileOrigin(*fileOrigin, true); err != nil {
		return err
	}
	service := &central.Service{DB: local.DB, Signer: signer, Keys: keys, Origin: origin, Development: true, Files: web.Handler(), Content: cosmetics, VerifierRegistry: registry.NewVerifier(origin, true, compatibility.Current()), OAuth: oauth2.Config{ClientID: "local-fixture", ClientSecret: "test-only", Endpoint: provider.Endpoint(), RedirectURL: origin + "/auth/callback", Scopes: []string{oidc.ScopeOpenID}}, Verifier: provider.Verifier(&oidc.Config{ClientID: "local-fixture", SupportedSigningAlgs: []string{"RS256"}})}
	// The fixture registers through the production owner API; only OIDC accounts
	// and the private bootstrap browser session are test-specific.
	token := identity.Random()
	sessionID := identity.ID()
	now := time.Now().UTC()
	if _, err = local.DB.Exec("INSERT INTO sessions(id,credential_hash,account_id,created_at,expires_at) VALUES($1,$2,$3,$4,$5)", sessionID, identity.Hash(token), strings.Repeat("1", 32), now, now.Add(identity.SessionLifetime)); err != nil {
		return err
	}
	for i, name := range []string{"Local A", "Local B"} {
		idPath := filepath.Join(*directory, fmt.Sprintf("server-%c.id", 'a'+i))
		savedID, readErr := os.ReadFile(idPath)
		if readErr != nil && !os.IsNotExist(readErr) {
			return readErr
		}
		address := fmt.Sprintf("http://%s:%d", *serverHost, 18080+i+*offset)
		var id, publicKey, status string
		var revision int64
		// Persist the fixture ID so edits, transfers and removals survive launcher restarts.
		if len(savedID) != 0 {
			err = local.DB.QueryRow("SELECT id,revision,public_key,status FROM registered_servers WHERE id=$1", string(savedID)).Scan(&id, &revision, &publicKey, &status)
		} else {
			// Recover a bootstrap response lost before writing its local ID file.
			err = local.DB.QueryRow("SELECT id,revision,public_key,status FROM registered_servers WHERE origin=$1 ORDER BY (status<>'removed') DESC LIMIT 1", address).Scan(&id, &revision, &publicKey, &status)
		}
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if id != "" {
			if err = os.WriteFile(idPath, []byte(id), 0600); err != nil {
				return err
			}
		}
		if publicKey != "" || status == "removed" {
			continue
		}
		target := "/api/v1/manage/servers"
		body := map[string]any{"name": name, "region": "Local", "origin": address}
		if id != "" {
			target += "/" + id + "/code"
			body = map[string]any{"revision": revision}
		}
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		request := httptest.NewRequest("POST", target, bytes.NewReader(raw))
		request.Header.Set("Origin", origin)
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(&http.Cookie{Name: "central_session", Value: token})
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			return fmt.Errorf("fixture registration: %s", response.Body.String())
		}
		var result struct {
			Code   string              `json:"code"`
			Server registry.Descriptor `json:"server"`
		}
		if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			return err
		}
		if err = os.WriteFile(idPath, []byte(result.Server.ID), 0600); err != nil {
			return err
		}
		if err = os.WriteFile(filepath.Join(*directory, fmt.Sprintf("server-%c.pairing", 'a'+i)), []byte(result.Code), 0600); err != nil {
			return err
		}
	}
	if _, err = local.DB.Exec("DELETE FROM sessions WHERE id=$1", sessionID); err != nil {
		return err
	}
	cleanupCtx, stopCleanup := context.WithCancel(ctx)
	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		service.RunCleanup(cleanupCtx)
	}()
	defer func() {
		stopCleanup()
		<-cleanupDone
	}()
	httpServer := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", 18090+*offset), Handler: service.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		if err := httpServer.Close(); err != nil {
			log.Print(err)
		}
	}()
	log.Printf("Local OIDC fixture at %s (not a production identity provider)", origin)
	err = httpServer.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
