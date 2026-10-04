package administration

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/transport"
)

func (s *Service) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/v1/rooms/") {
			id := strings.TrimPrefix(r.URL.Path, "/api/v1/rooms/")
			for _, room := range s.Rooms.Directory().Rooms {
				if room.ID == id {
					identity.JSON(w, http.StatusOK, room)
					return
				}
			}
			identity.Error(w, http.StatusNotFound, "room_not_found")
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/v1/") {
			identity.Error(w, http.StatusUpgradeRequired, "unsupported_api_version")
			return
		}
		if r.Method != "GET" && !identity.SameOrigin(r, s.Access.Origin()) {
			identity.Error(w, http.StatusForbidden, "origin_refused")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		who, err := s.Access.Current(r)
		if r.URL.Path == "/api/v1/me" && r.Method == "GET" {
			if err != nil && err.Error() != "guest_identity_required" {
				// Keep recovery navigation available without treating an expired account as a guest.
				identity.JSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error(), "loginAvailable": s.Access.Available(), "central": s.Access.Central()})
				return
			}
			current, err := role(r.Context(), s.DB, who.Subject)
			if err != nil {
				identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
			identity.JSON(w, http.StatusOK, map[string]any{"subject": who.Subject, "role": current, "loginAvailable": s.Access.Available(), "central": s.Access.Central()})
			return
		}
		if err != nil {
			identity.Error(w, http.StatusUnauthorized, "identity_required")
			return
		}
		current, err := role(r.Context(), s.DB, who.Subject)
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if r.Method != "GET" || r.URL.Path != "/api/v1/me/sanctions" {
			banned, err := s.blocked(r.Context(), who.Subject)
			if err != nil {
				identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
			if banned {
				identity.Error(w, http.StatusForbidden, "sanction_active")
				return
			}
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/admin/") && rank(current) < 1 {
			identity.Error(w, http.StatusForbidden, "staff_required")
			return
		}
		if r.Method == "GET" {
			s.read(w, r, who, current)
			return
		}
		switch {
		case r.URL.Path == "/api/v1/admin/roles" && r.Method == "POST":
			var input struct {
				Account string `json:"account"`
				Role    string `json:"role"`
			}
			if identity.Decode(w, r, &input) != nil {
				identity.Error(w, http.StatusBadRequest, "invalid_request")
				return
			}
			err = s.changeRole(r.Context(), who.Subject, current, input.Account, input.Role)
		case r.URL.Path == "/api/v1/admin/sanctions" && r.Method == "POST":
			var input struct {
				Target  string `json:"target"`
				Minutes int    `json:"minutes"`
				Reason  string `json:"reason"`
			}
			if identity.Decode(w, r, &input) != nil {
				identity.Error(w, http.StatusBadRequest, "invalid_request")
				return
			}
			err = s.ban(r.Context(), who.Subject, current, input.Target, input.Minutes, input.Reason)
		case r.URL.Path == "/api/v1/admin/kick" && r.Method == "POST":
			var input struct {
				Target string `json:"target"`
			}
			if identity.Decode(w, r, &input) != nil {
				identity.Error(w, http.StatusBadRequest, "invalid_request")
				return
			}
			err = s.kick(r.Context(), who.Subject, current, input.Target)
		case strings.HasPrefix(r.URL.Path, "/api/v1/admin/sanctions/") && r.Method == "DELETE":
			err = s.revokeSanction(r.Context(), who.Subject, current, strings.TrimPrefix(r.URL.Path, "/api/v1/admin/sanctions/"))
		case r.URL.Path == "/api/v1/admin/rooms" && r.Method == "POST":
			var input struct {
				Config hosting.Config `json:"config"`
			}
			if identity.Decode(w, r, &input) != nil {
				identity.Error(w, http.StatusBadRequest, "invalid_request")
				return
			}
			var id string
			id, err = s.createRoom(r.Context(), who.Subject, current, input.Config)
			if err == nil {
				d := s.Rooms.Directory()
				d.CreatedRoomID = id
				identity.JSON(w, http.StatusCreated, d)
				return
			}
		case strings.HasPrefix(r.URL.Path, "/api/v1/admin/rooms/") && r.Method == "PATCH":
			var input struct {
				Name string `json:"name"`
			}
			if identity.Decode(w, r, &input) != nil {
				identity.Error(w, http.StatusBadRequest, "invalid_request")
				return
			}
			err = s.renameRoom(r.Context(), who.Subject, current, strings.TrimPrefix(r.URL.Path, "/api/v1/admin/rooms/"), input.Name)
		case strings.HasPrefix(r.URL.Path, "/api/v1/admin/rooms/") && (r.Method == "PUT" || r.Method == "DELETE"):
			var op Operation
			id := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/rooms/")
			if r.Method == "PUT" {
				var input struct {
					Config  hosting.Config `json:"config"`
					Confirm bool           `json:"confirm"`
				}
				if identity.Decode(w, r, &input) != nil || !input.Confirm {
					identity.Error(w, http.StatusBadRequest, "confirmation_required")
					return
				}
				op, err = s.scheduleRoom(r.Context(), who.Subject, current, id, input.Config, false, who.Session)
			} else {
				var input struct {
					Confirm bool `json:"confirm"`
				}
				if identity.Decode(w, r, &input) != nil || !input.Confirm {
					identity.Error(w, http.StatusBadRequest, "confirmation_required")
					return
				}
				op, err = s.scheduleRoom(r.Context(), who.Subject, current, id, hosting.Config{}, true, who.Session)
			}
			if err == nil {
				identity.JSON(w, http.StatusAccepted, op)
				return
			}
		default:
			identity.Error(w, http.StatusNotFound, "endpoint_not_found")
			return
		}
		if err != nil {
			identity.Error(w, errorStatus(err), err.Error())
			return
		}
		identity.JSON(w, http.StatusOK, map[string]bool{"applied": true})
	})
}
func (s *Service) read(w http.ResponseWriter, r *http.Request, who transport.Identity, current string) {
	switch {
	case r.URL.Path == "/api/v1/admin/rooms":
		identity.JSON(w, http.StatusOK, s.Rooms.Directory())
	case r.URL.Path == "/api/v1/admin/participants":
		if rank(current) < 1 {
			identity.Error(w, http.StatusForbidden, "staff_required")
			return
		}
		people, err := s.Rooms.Participants(r.Context())
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "participants_unavailable")
			return
		}
		identity.JSON(w, http.StatusOK, people)
	case r.URL.Path == "/api/v1/admin/roles":
		if rank(current) < 2 {
			identity.Error(w, http.StatusForbidden, "admin_required")
			return
		}
		rows, err := s.DB.QueryContext(r.Context(), "SELECT account_id,role,actor,created_at,updated_at FROM roles ORDER BY account_id")
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		result := []Role{}
		for rows.Next() {
			var row Role
			var created, updated int64
			if err = rows.Scan(&row.Account, &row.Role, &row.Actor, &created, &updated); err != nil {
				break
			}
			row.CreatedAt = time.Unix(created, 0).UTC()
			row.UpdatedAt = time.Unix(updated, 0).UTC()
			result = append(result, row)
		}
		if finishRows(rows, err) != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		identity.JSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/v1/admin/sanctions" || r.URL.Path == "/api/v1/me/sanctions":
		query := "SELECT id,identity_kind,identity_id,actor,reason,created_at,expires_at,revoked_at,revoked_by FROM sanctions"
		args := []any{}
		if r.URL.Path == "/api/v1/me/sanctions" {
			kind, id, err := splitSubject(who.Subject)
			if err != nil {
				identity.Error(w, http.StatusBadRequest, "invalid_identity")
				return
			}
			query += " WHERE identity_kind=$1 AND identity_id=$2"
			args = []any{kind, id}
		}
		rows, err := s.DB.QueryContext(r.Context(), query+" ORDER BY created_at DESC LIMIT 500", args...)
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		result := []Sanction{}
		for rows.Next() {
			var row Sanction
			var created int64
			var expires, revoked *int64
			if err = rows.Scan(&row.ID, &row.Kind, &row.Target, &row.Actor, &row.Reason, &created, &expires, &revoked, &row.RevokedBy); err != nil {
				break
			}
			row.CreatedAt = time.Unix(created, 0).UTC()
			row.ExpiresAt = optionalDate(expires)
			row.RevokedAt = optionalDate(revoked)
			result = append(result, row)
		}
		if finishRows(rows, err) != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		identity.JSON(w, http.StatusOK, result)
	case r.URL.Path == "/api/v1/admin/events":
		if rank(current) < 1 {
			identity.Error(w, http.StatusForbidden, "staff_required")
			return
		}
		query := "SELECT id,actor,target,action,reason,created_at,details FROM events WHERE created_at>$1"
		if rank(current) < 2 {
			query += " AND action IN ('sanction','revoke_sanction','kick')"
		}
		rows, err := s.DB.QueryContext(r.Context(), query+" ORDER BY id DESC LIMIT 500", s.now().Add(-eventRetention).Unix())
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		result := []Event{}
		for rows.Next() {
			var row Event
			var created int64
			var raw string
			if err = rows.Scan(&row.ID, &row.Actor, &row.Target, &row.Action, &row.Reason, &created, &raw); err != nil {
				break
			}
			row.CreatedAt = time.Unix(created, 0).UTC()
			if row.Details, err = eventDetails(row.Action, raw); err != nil {
				break
			}
			result = append(result, row)
		}
		if finishRows(rows, err) != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		identity.JSON(w, http.StatusOK, result)
	case strings.HasPrefix(r.URL.Path, "/api/v1/admin/operations/"):
		op := s.operations[strings.TrimPrefix(r.URL.Path, "/api/v1/admin/operations/")]
		if op == nil {
			identity.Error(w, http.StatusNotFound, "operation_not_found")
			return
		}
		if rank(current) < 2 && op.Actor != who.Subject {
			identity.Error(w, http.StatusForbidden, "admin_required")
			return
		}
		identity.JSON(w, http.StatusOK, *op)
	case strings.HasPrefix(r.URL.Path, "/api/v1/admin/rooms/"):
		if rank(current) < 2 {
			identity.Error(w, http.StatusForbidden, "admin_required")
			return
		}
		var raw string
		err := s.DB.QueryRowContext(r.Context(), "SELECT configuration FROM rooms WHERE id=$1", strings.TrimPrefix(r.URL.Path, "/api/v1/admin/rooms/")).Scan(&raw)
		if err != nil {
			identity.Error(w, http.StatusNotFound, "room_not_found")
			return
		}
		identity.JSON(w, http.StatusOK, json.RawMessage(raw))
	default:
		identity.Error(w, http.StatusNotFound, "endpoint_not_found")
	}
}
func finishRows(rows *sql.Rows, err error) error { return errors.Join(err, rows.Err(), rows.Close()) }
