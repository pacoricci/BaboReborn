// Package access validates portal-issued proofs without cross-site cookies.
package access

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
	"baboreborn/backend/server/transport"
)

type Config struct {
	Server, Origin, Central, KeysPath string
	Development                       bool
	Association                       func() registry.Descriptor
}
type Manager struct {
	mu       sync.Mutex
	config   Config
	keys     jose.JSONWebKeySet
	sessions map[string]*transport.Identity
	client   *http.Client
	Apply    func(context.Context, transport.Administration) error
	Now      func() time.Time
}

func New(config Config) (*Manager, error) {
	var err error
	config.Origin, err = identity.CanonicalOrigin(config.Origin, config.Development)
	if err != nil {
		return nil, fmt.Errorf("portal origin required")
	}
	config.Central, err = identity.CanonicalOrigin(config.Central, config.Development)
	if err != nil {
		return nil, fmt.Errorf("portal origin required")
	}

	m := &Manager{config: config, sessions: map[string]*transport.Identity{}, client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
	if config.KeysPath != "" {
		keys, err := identity.LoadKeys(config.KeysPath)
		if err == nil {
			m.keys = keys
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	return m, nil
}
func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}
func (m *Manager) Available() bool { return true }
func (m *Manager) Central() string { return m.config.Central }
func (m *Manager) Origin() string  { return m.config.Origin }

var guestID = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (m *Manager) current(r *http.Request) (transport.Identity, error) {
	server := m.config.Server
	if m.config.Association != nil {
		d := m.config.Association()
		if d.ID == "" || d.Status == "removed" {
			return transport.Identity{}, fmt.Errorf("server_unassociated")
		}
		server = d.ID
	}
	auth := r.Header.Get("Authorization")
	if auth != "" {
		if !strings.HasPrefix(auth, "Bearer ") {
			return transport.Identity{}, fmt.Errorf("invalid_authorization")
		}
		claims, err := identity.Verify(strings.TrimPrefix(auth, "Bearer "), m.config.Central, server, m.keys, m.now())
		if err != nil {
			return transport.Identity{}, fmt.Errorf("authentication_expired")
		}
		who := transport.Identity{Subject: "account:" + claims.Subject, Session: claims.Session, Expires: claims.Expiry.Time()}
		old := m.sessions[who.Session]
		if old != nil && old.Subject != who.Subject {
			return transport.Identity{}, fmt.Errorf("invalid_session")
		}
		// An in-flight request with an older proof must not shorten a renewed session.
		if old == nil || who.Expires.After(old.Expires) {
			m.sessions[who.Session] = &who
		}
		return who, nil
	}
	guest := r.Header.Get("X-Guest-ID")
	if !guestID.MatchString(guest) {
		return transport.Identity{}, fmt.Errorf("guest_identity_required")
	}
	return transport.Identity{Subject: "guest:" + guest}, nil
}
func (m *Manager) Current(r *http.Request) (transport.Identity, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.current(r)
}
func (m *Manager) WithCurrent(r *http.Request, join func(transport.Identity) error) error {
	if !identity.SameOrigin(r, m.config.Origin) {
		return fmt.Errorf("origin_refused")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	who, err := m.current(r)
	if err != nil {
		return err
	}
	return join(who)
}
func (m *Manager) CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Even a request without Origin must not seed a shared cache for CORS callers.
		w.Header().Add("Vary", "Origin")
		if origin := r.Header.Get("Origin"); origin != "" {
			if origin != m.config.Origin {
				identity.Error(w, http.StatusForbidden, "origin_refused")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Guest-ID")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == "OPTIONS" {
			if !identity.SameOrigin(r, m.config.Origin) {
				identity.Error(w, http.StatusForbidden, "origin_refused")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (m *Manager) RefreshKeys(ctx context.Context) error {
	if !m.Available() {
		return nil
	}
	req, err := http.NewRequestWithContext(ctx, "GET", m.config.Central+"/identity/v1/keys", nil)
	if err != nil {
		return err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck // Closed after bounded reading.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("key_refresh_refused")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	if err != nil || len(data) > 65536 {
		return fmt.Errorf("invalid_key_response")
	}
	// Validate before replacing either the disk cache or the in-memory key set.
	var keys jose.JSONWebKeySet
	if err = json.Unmarshal(data, &keys); err != nil {
		return err
	}
	if err = identity.ValidateKeys(keys); err != nil {
		return err
	}
	if m.config.KeysPath != "" {
		if err = identity.SaveKeys(m.config.KeysPath, data); err != nil {
			return err
		}
	}
	m.mu.Lock()
	m.keys = keys
	m.mu.Unlock()
	return nil
}

func (m *Manager) Maintain(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key, s := range m.sessions {
		if !s.Expires.After(m.now()) {
			delete(m.sessions, key)
		}
	}
}
func (m *Manager) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.Maintain(ctx)
			if err := m.RefreshKeys(ctx); err != nil {
				log.Printf("Central key refresh unavailable; cached keys retained")
			}
		}
	}
}
func (m *Manager) VerifyAccount(ctx context.Context, id string) error {
	if !m.Available() {
		return fmt.Errorf("central_not_configured")
	}
	request, err := http.NewRequestWithContext(ctx, "GET", m.config.Central+"/identity/v1/accounts/"+url.PathEscape(id), nil)
	if err != nil {
		return err
	}
	response, err := m.client.Do(request)
	if err != nil {
		return fmt.Errorf("central_unavailable")
	}
	defer response.Body.Close() //nolint:errcheck // Bounded account lookup.
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("account_not_found")
	}
	var account identity.Account
	if err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&account); err != nil || account.ID != id {
		return fmt.Errorf("invalid_account_response")
	}
	return nil
}

func (m *Manager) ValidSession(session, subject string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[session]
	return s != nil && s.Subject == subject && s.Expires.After(m.now())
}

func (m *Manager) VerifyRegistry(proof, nonce string, target any) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return identity.VerifyRegistry(proof, m.config.Central, nonce, m.keys, target)
}
