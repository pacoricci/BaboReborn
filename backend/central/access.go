package central

import (
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
)

func loginReturn(r *http.Request) string {
	target := r.URL.Query().Get("return")
	u, err := url.Parse(target)
	if err != nil || u.IsAbs() || u.Host != "" || strings.ContainsAny(target, "\\\r\n") {
		return "/account"
	}
	switch u.Path {
	case "/character", "/options", "/editor.html", "/manage/servers", "/account", "/":
		return u.String()
	}
	if strings.HasPrefix(u.Path, "/rooms/") {
		if _, _, ok := registry.ParseRoomRef(strings.TrimPrefix(u.Path, "/rooms/")); ok {
			return u.String()
		}
	}
	if strings.HasPrefix(u.Path, "/manage/servers/") && registry.ValidID(strings.TrimPrefix(u.Path, "/manage/servers/")) {
		return u.String()
	}
	return "/account"
}
func (s *Service) accountState(w http.ResponseWriter, r *http.Request) {
	current, err := s.session(r)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, http.ErrNoCookie) {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		_, cookieErr := r.Cookie("central_session")
		identity.JSON(w, http.StatusOK, map[string]any{"account": "", "expired": cookieErr == nil, "loginAvailable": s.Verifier != nil})
		return
	}
	identity.JSON(w, http.StatusOK, map[string]any{"account": current.Account, "expired": false, "loginAvailable": s.Verifier != nil})
}
func (s *Service) accessProof(w http.ResponseWriter, r *http.Request) {
	if !identity.SameOrigin(r, s.Origin) {
		identity.Error(w, http.StatusForbidden, "origin_refused")
		return
	}
	current, err := s.session(r)
	if err != nil {
		identity.Error(w, http.StatusUnauthorized, "authentication_expired")
		return
	}
	var request struct {
		ServerID string `json:"serverId"`
	}
	if identity.Decode(w, r, &request) != nil {
		identity.Error(w, http.StatusBadRequest, "invalid_request")
		return
	}
	server, err := s.readServer(r.Context(), s.DB, request.ServerID, false)
	if err != nil || !server.Online {
		identity.Error(w, http.StatusConflict, "server_unavailable")
		return
	}
	tokens, err := s.Signer.Issue(current.Account, server.ID, current.ID, s.now(), current.Expires)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "identity_unavailable")
		return
	}
	identity.JSON(w, http.StatusOK, tokens)
}

func rollback(tx *sql.Tx, err *error) {
	if e := tx.Rollback(); e != nil && !errors.Is(e, sql.ErrTxDone) {
		*err = errors.Join(*err, e)
	}
}
