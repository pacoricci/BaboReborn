package hosting

import (
	"fmt"
	"net/http"

	"baboreborn/backend/identity"
	"baboreborn/backend/server/transport"
)

// SetUpdaterToken is composition-only. The host keeps the credential private.
func (m *Manager) SetUpdaterToken(token string) { m.updaterToken = token }

func (m *Manager) admission(r *http.Request, join func(transport.Identity) error) error {
	guarded := func(who transport.Identity) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.draining {
			return fmt.Errorf("server_updating")
		}
		// Hold the gate until the owner acknowledges registration and its count.
		return join(who)
	}
	// Policy may hold administration locks and call hosting; acquire our gate
	// only inside its join callback to preserve that lock order.
	if m.admit != nil {
		return m.admit(r, guarded)
	}
	return guarded(transport.Identity{})
}

func (m *Manager) updateAdmission(w http.ResponseWriter, r *http.Request) {
	if m.updaterToken == "" || r.Header.Get("Origin") != "" || !identity.Equal(r.Header.Get("Authorization"), "Bearer "+m.updaterToken) {
		identity.Error(w, http.StatusForbidden, "updater_authorization_required")
		return
	}
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		w.Header().Set("Allow", "POST, DELETE")
		identity.Error(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	m.mu.Lock()
	if r.Context().Err() != nil {
		m.mu.Unlock()
		identity.Error(w, http.StatusServiceUnavailable, "request_cancelled")
		return
	}
	if r.Method == http.MethodPost && m.humansLocked() != 0 {
		m.mu.Unlock()
		identity.Error(w, http.StatusConflict, "server_busy")
		return
	}
	// This same lock covers every join callback, including admissions already
	// in flight and rooms installed while the deployment is in progress.
	m.draining = r.Method == http.MethodPost
	m.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}
