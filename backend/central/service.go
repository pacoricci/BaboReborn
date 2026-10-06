// Package central owns account/session transactions and the public identity adapter.
package central

import (
	"database/sql"
	"errors"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
)

type Service struct {
	releaseMu           sync.Mutex
	releaseObservations map[string]releaseObservation
	publicationMu       sync.Mutex
	publications        map[string]publishedSnapshot
	DB                  *sql.DB
	Signer              *identity.Signer
	Keys                jose.JSONWebKeySet
	Origin              string
	Development         bool
	OAuth               oauth2.Config
	Verifier            *oidc.IDTokenVerifier
	Now                 func() time.Time
	VerifierRegistry    *registry.Verifier
	Files               http.Handler
	Content             http.Handler
}
type session struct {
	ID, Account string
	Expires     time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func (s *Service) session(r *http.Request) (session, error) {
	var result session
	cookie, err := r.Cookie("central_session")
	if err != nil {
		return result, err
	}
	err = s.DB.QueryRowContext(r.Context(), "SELECT id,account_id,expires_at FROM sessions WHERE credential_hash=$1 AND revoked_at IS NULL AND expires_at>$2", identity.Hash(cookie.Value), s.now()).Scan(&result.ID, &result.Account, &result.Expires)
	return result, err
}
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /identity/v1/keys", func(w http.ResponseWriter, r *http.Request) { identity.JSON(w, http.StatusOK, s.Keys) })
	mux.HandleFunc("GET /identity/v1/accounts/{id}", s.account)
	mux.HandleFunc("POST /identity/v1/access", s.accessProof)
	mux.HandleFunc("GET /api/v1/account", s.accountState)
	mux.HandleFunc("GET /api/v1/rooms", s.publicRooms)
	mux.HandleFunc("GET /api/v1/rooms/{ref}", s.publicRooms)
	mux.HandleFunc("POST /registry/v1/publication", s.publication)
	mux.HandleFunc("/api/v1/manage/servers", s.manageServers)
	mux.HandleFunc("/api/v1/manage/servers/{id}", s.manageServers)
	mux.HandleFunc("/api/v1/manage/servers/{id}/{action}", s.manageServers)
	mux.HandleFunc("POST /registry/v1/nonce", s.registryNonce)
	mux.HandleFunc("POST /registry/v1/request", s.registryRequest)
	mux.HandleFunc("/identity/", func(w http.ResponseWriter, r *http.Request) {
		identity.Error(w, http.StatusUpgradeRequired, "unsupported_identity_version_or_endpoint")
	})
	mux.HandleFunc("GET /auth/login", func(w http.ResponseWriter, r *http.Request) { s.login(w, r, loginReturn(r)) })
	mux.HandleFunc("GET /auth/callback", s.callback)
	mux.HandleFunc("POST /auth/logout", func(w http.ResponseWriter, r *http.Request) { s.revoke(w, r, false) })
	mux.HandleFunc("POST /auth/revoke-all", func(w http.ResponseWriter, r *http.Request) { s.revoke(w, r, true) })
	mux.HandleFunc("POST /auth/delete-account", s.deleteAccount)
	mux.HandleFunc("GET /assets/account.js", serveAccountScript)
	mux.HandleFunc("GET /assets/topbar.css", serveTopbarStyle)
	mux.HandleFunc("GET /assets/product.css", serveProductStyle)
	mux.HandleFunc("GET /{$}", s.productPage("landing.html"))
	mux.HandleFunc("GET /landing.html", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /rooms", s.productPage("play.html"))
	mux.HandleFunc("GET /character", s.productPage("play.html"))
	mux.HandleFunc("GET /options", s.productPage("play.html"))
	mux.HandleFunc("GET /rooms/{ref}", s.productPage("match.html"))
	mux.HandleFunc("GET /manage/servers/{id}", s.productPage("manage.html"))
	mux.HandleFunc("GET /account", s.home)
	mux.HandleFunc("GET /manage/servers", s.home)
	mux.HandleFunc("GET /assets/management.css", serveManagementStyle)
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/content/") && s.Content != nil {
			s.Content.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/rooms.html" || r.URL.Path == "/match.html" || r.URL.Path == "/play.html" || r.URL.Path == "/manage.html" {
			http.NotFound(w, r)
			return
		}
		if s.Files != nil {
			w.Header().Set("Cache-Control", frontendCacheControl(r.URL.Path))
			s.Files.ServeHTTP(w, r)
			return
		}
		http.NotFound(w, r)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		if s.Development {
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; img-src 'self' https: http://127.0.0.1:* http://localhost:* blob: data:; form-action 'self'; frame-ancestors 'none'")
		} else {
			w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: https: wss:; img-src 'self' https: blob: data:; worker-src 'self' blob:; form-action 'self'; frame-ancestors 'none'")
		}
		mux.ServeHTTP(w, r)
	})
}

func frontendCacheControl(name string) string {
	if fingerprintedAsset(name) {
		return "public, max-age=31536000, immutable"
	}
	if path.Ext(name) != ".html" && path.Ext(name) != "" {
		return "public, max-age=3600"
	}
	return "no-store"
}

func fingerprintedAsset(name string) bool {
	if !strings.HasPrefix(name, "/assets/") {
		return false
	}
	base := path.Base(name)
	extension := path.Ext(base)
	stem := base[:len(base)-len(extension)]
	if len(stem) < 10 || stem[len(stem)-9] != '-' {
		return false
	}
	hash := stem[len(stem)-8:]
	for _, character := range hash {
		if character != '_' && character != '-' &&
			(character < '0' || character > '9') &&
			(character < 'A' || character > 'Z') &&
			(character < 'a' || character > 'z') {
			return false
		}
	}
	return true
}

func (s *Service) account(w http.ResponseWriter, r *http.Request) {
	var id string
	err := s.DB.QueryRowContext(r.Context(), "SELECT id FROM accounts WHERE id=$1", r.PathValue("id")).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		identity.Error(w, http.StatusNotFound, "account_not_found")
		return
	}
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	identity.JSON(w, http.StatusOK, identity.Account{ID: id})
}
func (s *Service) revoke(w http.ResponseWriter, r *http.Request, all bool) {
	if !identity.SameOrigin(r, s.Origin) {
		identity.Error(w, http.StatusForbidden, "origin_refused")
		return
	}
	current, err := s.session(r)
	if err != nil {
		identity.Error(w, http.StatusUnauthorized, "login_required")
		return
	}
	query := "UPDATE sessions SET revoked_at=$1 WHERE id=$2"
	target := current.ID
	if all {
		query = "UPDATE sessions SET revoked_at=$1 WHERE account_id=$2"
		target = current.Account
	}
	if _, err = s.DB.ExecContext(r.Context(), query, s.now(), target); err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	identity.Cookie(w, "central_session", "signed-out", !s.Development, int(identity.SessionLifetime.Seconds()))
	notice := "signed_out"
	if all {
		notice = "sessions_revoked"
	}
	http.Redirect(w, r, "/account?notice="+notice, http.StatusSeeOther)
}
