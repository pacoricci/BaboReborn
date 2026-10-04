package central

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
)

type serverReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

const serverSelect = `SELECT id,owner_id,name,region,origin,candidate_origin,public_key,revision,applied_revision,operation_id,status,last_seen_at,last_verified_at,last_error,compatible,COALESCE(transfer_to,''),transfer_expires_at,transfer_accepted,verified_contract FROM registered_servers`

type serverScanner interface {
	Scan(...any) error
}

func (s *Service) readServer(ctx context.Context, db serverReader, id string, lock bool) (registry.Descriptor, error) {
	query := serverSelect + " WHERE id=$1"
	if lock {
		query += " FOR UPDATE"
	}
	return s.scanServer(db.QueryRowContext(ctx, query, id))
}

// Both lookup paths apply the current contract and presence window to stored state.
func (s *Service) scanServer(row serverScanner) (registry.Descriptor, error) {
	var d registry.Descriptor
	var contract string
	if err := row.Scan(&d.ID, &d.Owner, &d.Name, &d.Region, &d.Origin, &d.CandidateOrigin, &d.PublicKey, &d.Revision, &d.AppliedRevision, &d.OperationID, &d.Status, &d.LastSeenAt, &d.LastVerifiedAt, &d.Error, &d.Compatible, &d.TransferTo, &d.TransferExpiresAt, &d.TransferAccepted, &contract); err != nil {
		return d, err
	}
	if s.VerifierRegistry == nil || contract != s.contractStamp() {
		d.Compatible = false
	}
	cutoff := s.now().Add(-registry.Presence)
	d.Online = d.Status == "active" && d.AppliedRevision == d.Revision && d.Compatible && d.LastSeenAt != nil && d.LastVerifiedAt != nil && d.LastSeenAt.After(cutoff) && d.LastVerifiedAt.After(cutoff)
	return d, nil
}
func (s *Service) contractStamp() string {
	if s.VerifierRegistry == nil {
		return ""
	}
	c := s.VerifierRegistry.Expected
	return identity.Challenge(fmt.Sprintf("%d/%d/%d/%s/%d/%d", c.API, c.Identity, c.Protocol, c.Profile, c.ContentSchema, c.Publication))
}
func (s *Service) listServers(ctx context.Context, account string) ([]registry.Descriptor, error) {
	return s.queryServers(ctx, account, false)
}
func (s *Service) queryServers(ctx context.Context, account string, all bool) ([]registry.Descriptor, error) {
	query := serverSelect + " WHERE status <> 'removed'"
	args := []any{}
	if account != "" {
		query += " AND (owner_id=$1 OR transfer_to=$1)"
		args = append(args, account)
	}
	query += " ORDER BY name,id"
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	result := []registry.Descriptor{}
	for rows.Next() {
		var d registry.Descriptor
		d, err = s.scanServer(rows)
		if err != nil {
			break
		}
		if all || account != "" || d.Online {
			result = append(result, d)
		}
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	return result, nil
}
func publicServer(d registry.Descriptor) any {
	return struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Region     string `json:"region"`
		Origin     string `json:"origin"`
		PublicKey  string `json:"publicKey"`
		Online     bool   `json:"online"`
		Compatible bool   `json:"compatible"`
	}{d.ID, d.Name, d.Region, d.Origin, d.PublicKey, d.Online, d.Compatible}
}
func registryEvent(ctx context.Context, tx *sql.Tx, d registry.Descriptor, actor, action string, now time.Time) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO registry_events(server_id,actor,action,created_at,revision) VALUES($1,$2,$3,$4,$5)", d.ID, actor, action, now, d.Revision)
	return err
}
func (s *Service) manageServers(w http.ResponseWriter, r *http.Request) {
	current, err := s.session(r)
	if err != nil {
		identity.Error(w, http.StatusUnauthorized, "login_required")
		return
	}
	if r.Method != "GET" && !identity.SameOrigin(r, s.Origin) {
		identity.Error(w, http.StatusForbidden, "origin_refused")
		return
	}
	// Expired invitations never keep an owner's registration locked.
	if _, err = s.DB.ExecContext(r.Context(), "UPDATE registered_servers SET transfer_to=NULL,transfer_expires_at=NULL WHERE NOT transfer_accepted AND transfer_expires_at <= $1", s.now()); err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	if r.Method == "GET" {
		ds, err := s.managementServers(r.Context(), current.Account)
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if id := r.PathValue("id"); id != "" {
			for _, d := range ds {
				if d.ID == id {
					identity.JSON(w, http.StatusOK, d)
					return
				}
			}
			identity.Error(w, http.StatusNotFound, "server_not_found")
			return
		}
		identity.JSON(w, http.StatusOK, ds)
		return
	}
	var input struct {
		Name     string `json:"name"`
		Region   string `json:"region"`
		Origin   string `json:"origin"`
		Account  string `json:"account"`
		Revision int64  `json:"revision"`
	}
	if r.Method != "DELETE" && identity.Decode(w, r, &input) != nil {
		identity.Error(w, http.StatusBadRequest, "invalid_request")
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	defer tx.Rollback() //nolint:errcheck // Commit or rollback below owns the result.
	id, action := r.PathValue("id"), r.PathValue("action")
	var d registry.Descriptor
	code := ""
	var expiresAt *time.Time
	fail := func(status int, reason string) { identity.Error(w, status, reason) }
	if id == "" {
		if r.Method != "POST" {
			fail(http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		input.Region = strings.TrimSpace(input.Region)
		input.Origin, err = identity.CanonicalOrigin(input.Origin, s.Development)
		if err != nil || !validMetadata(input.Name, input.Region) {
			fail(http.StatusBadRequest, "invalid_server_data")
			return
		}
		// Serialize origin reservations across committed and candidate addresses.
		if _, err = tx.ExecContext(r.Context(), "SELECT pg_advisory_xact_lock(731622)"); err != nil {
			fail(http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		var used int
		err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM registered_servers WHERE status <> 'removed' AND (origin=$1 OR candidate_origin=$1)", input.Origin).Scan(&used)
		if err != nil || used != 0 {
			fail(http.StatusConflict, "origin_already_registered")
			return
		}
		if err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM registered_servers WHERE owner_id=$1 AND status='pending'", current.Account).Scan(&used); err != nil || used >= 10 {
			fail(http.StatusTooManyRequests, "pending_registration_limit")
			return
		}
		d = registry.Descriptor{ID: identity.ID(), Owner: current.Account, Name: input.Name, Region: input.Region, Origin: input.Origin, Revision: 1, OperationID: identity.ID(), Status: "pending"}
		_, err = tx.ExecContext(r.Context(), `INSERT INTO registered_servers(id,owner_id,name,region,origin,revision,operation_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, d.ID, d.Owner, d.Name, d.Region, d.Origin, d.Revision, d.OperationID, d.Status)
		action = "register"
	} else {
		// Match the create path's lock order to avoid address-edit deadlocks.
		if r.Method == "PATCH" {
			if _, err = tx.ExecContext(r.Context(), "SELECT pg_advisory_xact_lock(731622)"); err != nil {
				fail(http.StatusServiceUnavailable, "storage_unavailable")
				return
			}
		}
		d, err = s.readServer(r.Context(), tx, id, true)
		if err != nil || d.Status == "removed" {
			fail(http.StatusNotFound, "server_not_found")
			return
		}
		recipient := (action == "accept" || action == "reject") && d.TransferTo == current.Account
		if d.Owner != current.Account && !recipient {
			fail(http.StatusForbidden, "owner_required")
			return
		}
		if r.Method != "DELETE" && input.Revision != d.Revision {
			fail(http.StatusConflict, "stale_revision")
			return
		}
		if d.TransferAccepted || d.PublicKey != "" && d.AppliedRevision != d.Revision {
			fail(http.StatusConflict, "operation_pending")
			return
		}
		switch {
		case r.Method == "DELETE":
			action = "remove"
			d.Revision++
			d.OperationID = identity.ID()
			_, err = tx.ExecContext(r.Context(), "UPDATE registered_servers SET status='removed',revision=$2,operation_id=$3,transfer_to=NULL,transfer_expires_at=NULL,compatible=FALSE WHERE id=$1", id, d.Revision, d.OperationID)
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "DELETE FROM pairing_codes WHERE server_id=$1", id)
			}
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "DELETE FROM registry_nonces WHERE server_id=$1", id)
			}
		case r.Method == "PATCH" && action == "":
			input.Origin, err = identity.CanonicalOrigin(input.Origin, s.Development)
			if err != nil || !validMetadata(input.Name, input.Region) {
				fail(http.StatusBadRequest, "invalid_server_data")
				return
			}
			input.Origin = strings.TrimRight(input.Origin, "/")
			var used int
			err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM registered_servers WHERE id<>$1 AND status<>'removed' AND (origin=$2 OR candidate_origin=$2)", id, input.Origin).Scan(&used)
			if err != nil || used != 0 {
				fail(http.StatusConflict, "origin_already_registered")
				return
			}
			candidate := ""
			if input.Origin != d.Origin {
				candidate = input.Origin
			}
			_, err = tx.ExecContext(r.Context(), "UPDATE registered_servers SET name=$2,region=$3,candidate_origin=$4 WHERE id=$1", id, strings.TrimSpace(input.Name), strings.TrimSpace(input.Region), candidate)
			action = "edit"
		case r.Method == "POST" && (action == "code" || action == "recover"):
			if d.TransferTo != "" {
				fail(http.StatusConflict, "transfer_pending")
				return
			}
		case r.Method == "POST" && action == "transfer":
			if input.Account == d.Owner || d.PublicKey == "" {
				fail(http.StatusBadRequest, "invalid_transfer")
				return
			}
			var account string
			if tx.QueryRowContext(r.Context(), "SELECT id FROM accounts WHERE id=$1", input.Account).Scan(&account) != nil {
				fail(http.StatusBadRequest, "account_not_found")
				return
			}
			if d.TransferTo != "" {
				fail(http.StatusConflict, "transfer_pending")
				return
			}
			_, err = tx.ExecContext(r.Context(), "UPDATE registered_servers SET transfer_to=$2,transfer_expires_at=$3 WHERE id=$1", id, account, s.now().Add(24*time.Hour))
		case r.Method == "POST" && action == "accept" && recipient:
			d.Revision++
			d.OperationID = identity.ID()
			_, err = tx.ExecContext(r.Context(), "UPDATE registered_servers SET transfer_accepted=TRUE,revision=$2,operation_id=$3 WHERE id=$1", id, d.Revision, d.OperationID)
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "DELETE FROM pairing_codes WHERE server_id=$1", id)
			}
		case r.Method == "POST" && (action == "reject" && recipient || action == "cancel-transfer" && d.Owner == current.Account):
			_, err = tx.ExecContext(r.Context(), "UPDATE registered_servers SET transfer_to=NULL,transfer_expires_at=NULL WHERE id=$1", id)
		default:
			fail(http.StatusMethodNotAllowed, "invalid_operation")
			return
		}
	}
	if err == nil && id != "" && action != "remove" && action != "accept" {
		// Metadata and invitations advance optimistic concurrency without withdrawing
		// an already confirmed installation. Authority changes still require its ack.
		d.Revision++
		d.OperationID = identity.ID()
		_, err = tx.ExecContext(r.Context(), "UPDATE registered_servers SET applied_revision=CASE WHEN applied_revision=revision THEN $2 ELSE applied_revision END,revision=$2,operation_id=$3 WHERE id=$1", id, d.Revision, d.OperationID)
	}
	if err == nil && (action == "register" || action == "code" || action == "recover") {
		code = identity.Random()
		expires := s.now().Add(registry.PairingLifetime)
		expiresAt = &expires
		_, err = tx.ExecContext(r.Context(), `INSERT INTO pairing_codes(credential_hash,server_id,expires_at) VALUES($1,$2,$3) ON CONFLICT(server_id) DO UPDATE SET credential_hash=excluded.credential_hash,expires_at=excluded.expires_at,claimed_key='',nonce_key=''`, identity.Hash(code), d.ID, expires)
		if err == nil {
			_, err = tx.ExecContext(r.Context(), "DELETE FROM registry_nonces WHERE server_id=$1 AND purpose='claim'", d.ID)
		}
	}
	if err == nil {
		err = registryEvent(r.Context(), tx, d, current.Account, action, s.now())
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		fail(http.StatusConflict, "registration_conflict")
		return
	}
	s.releaseMu.Lock()
	delete(s.releaseObservations, d.ID)
	s.releaseMu.Unlock()
	s.publicationMu.Lock()
	delete(s.publications, d.ID)
	s.publicationMu.Unlock()
	d, err = s.readServer(r.Context(), s.DB, d.ID, false)
	if err != nil {
		fail(http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	identity.JSON(w, http.StatusOK, struct {
		Server    registry.Descriptor `json:"server"`
		Code      string              `json:"code,omitempty"`
		ExpiresAt *time.Time          `json:"expiresAt,omitempty"`
	}{d, code, expiresAt})
}
func validMetadata(name, region string) bool {
	return strings.TrimSpace(name) != "" && len([]rune(name)) <= 100 && strings.TrimSpace(region) != "" && len([]rune(region)) <= 80
}
func (s *Service) registryRequest(w http.ResponseWriter, r *http.Request) {
	var packet registry.Packet
	var input registry.Request
	if identity.Decode(w, r, &packet) != nil || packet.Verify(&input) != nil {
		identity.Error(w, http.StatusUnauthorized, "invalid_signature")
		return
	}
	if input.Action != "claim" && input.Action != "heartbeat" && input.Action != "ack" {
		identity.Error(w, http.StatusBadRequest, "invalid_registry_action")
		return
	}
	var nonce string
	err := s.DB.QueryRowContext(r.Context(), `UPDATE registry_nonces SET consumed_at=$3
		WHERE nonce=$1 AND public_key=$2 AND expires_at>$3 AND consumed_at IS NULL
		AND purpose=$4 AND server_id=CASE WHEN $4='claim'
			THEN (SELECT server_id FROM pairing_codes WHERE credential_hash=$6)
			ELSE $5 END RETURNING nonce`, input.Nonce, packet.Key, s.now(), input.Action, input.ServerID, identity.Hash(input.Code)).Scan(&nonce)
	if err != nil {
		identity.Error(w, http.StatusUnauthorized, "invalid_nonce")
		return
	}
	d, err := s.registryOperation(r.Context(), packet.Key, input)
	if err != nil {
		code, recoverable := registryProblem(err)
		identity.JSON(w, http.StatusConflict, map[string]any{"error": code, "recoverable": recoverable, "operationId": d.OperationID, "revision": d.Revision, "status": d.Status})
		return
	}
	if d.TransferAccepted {
		d.Owner = d.TransferTo
	}
	proof, err := s.Signer.SignRegistry(input.Nonce, d)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "registry_signing_unavailable")
		return
	}
	identity.JSON(w, http.StatusOK, map[string]string{"response": proof})
}
func (s *Service) registryOperation(ctx context.Context, key string, input registry.Request) (registry.Descriptor, error) {
	id := input.ServerID
	if input.Action == "claim" {
		var claimed string
		var expires time.Time
		err := s.DB.QueryRowContext(ctx, "SELECT server_id,claimed_key,expires_at FROM pairing_codes WHERE credential_hash=$1", identity.Hash(input.Code)).Scan(&id, &claimed, &expires)
		if err != nil || claimed != "" && claimed != key || claimed == "" && !expires.After(s.now()) {
			return registry.Descriptor{}, fmt.Errorf("invalid_pairing_code")
		}
	} else if input.Action != "heartbeat" && input.Action != "ack" {
		return registry.Descriptor{}, fmt.Errorf("invalid_registry_action")
	}
	before, err := s.readServer(ctx, s.DB, id, false)
	if err != nil {
		return before, fmt.Errorf("server_not_found")
	}
	if input.Action != "claim" && before.PublicKey != key {
		return before, fmt.Errorf("installation_revoked")
	}
	if before.Status == "removed" {
		return before, nil
	}
	if input.Action == "claim" && before.TransferTo != "" {
		return before, fmt.Errorf("transfer_pending")
	}
	probeErr := error(nil)
	var observed *registry.Probe
	observedOrigin := before.Origin
	checkedAt := s.now()
	candidateOK := false
	if input.Action != "ack" {
		if s.VerifierRegistry == nil {
			return before, fmt.Errorf("verification_unavailable")
		}
		if before.CandidateOrigin != "" {
			observed, probeErr = s.VerifierRegistry.Check(ctx, before.CandidateOrigin, key)
			candidateOK = probeErr == nil
			if candidateOK {
				observedOrigin = before.CandidateOrigin
			}
		}
		if !candidateOK {
			observed, probeErr = s.VerifierRegistry.Check(ctx, before.Origin, key)
		}
		if probeErr != nil && input.Action == "claim" {
			// Keep the owner informed without invalidating an existing installation during recovery.
			if _, err = s.DB.ExecContext(ctx, "UPDATE registered_servers SET last_error=$2 WHERE id=$1 AND revision=$3", id, probeErr.Error(), before.Revision); err != nil {
				return before, err
			}
			return before, probeErr
		}
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return before, err
	}
	defer tx.Rollback() //nolint:errcheck // Final cleanup.
	d, err := s.readServer(ctx, tx, id, true)
	if err != nil {
		return d, err
	}
	if d.Status == "removed" {
		return d, nil
	}
	if d.Revision != before.Revision || d.PublicKey != before.PublicKey || d.CandidateOrigin != before.CandidateOrigin {
		return d, fmt.Errorf("retry_registry_operation")
	}
	switch input.Action {
	case "claim":
		var claimed string
		var expires time.Time
		err = tx.QueryRowContext(ctx, "SELECT claimed_key,expires_at FROM pairing_codes WHERE credential_hash=$1 AND server_id=$2 FOR UPDATE", identity.Hash(input.Code), id).Scan(&claimed, &expires)
		if err != nil || claimed != "" && claimed != key || claimed == "" && !expires.After(s.now()) {
			return d, fmt.Errorf("invalid_pairing_code")
		}
		if claimed == "" {
			d.Revision++
			d.OperationID = identity.ID()
			_, err = tx.ExecContext(ctx, "UPDATE pairing_codes SET claimed_key=$2 WHERE server_id=$1", id, key)
			if err == nil {
				_, err = tx.ExecContext(ctx, "UPDATE registered_servers SET public_key=$2,revision=$3,operation_id=$4,status='pending',last_seen_at=$5,last_verified_at=$5,compatible=TRUE,last_error='',verified_contract=$6 WHERE id=$1", id, key, d.Revision, d.OperationID, s.now(), s.contractStamp())
			}
			if err == nil && candidateOK {
				_, err = tx.ExecContext(ctx, "UPDATE registered_servers SET origin=candidate_origin,candidate_origin='' WHERE id=$1", id)
			}
			if err == nil {
				err = registryEvent(ctx, tx, d, key, "associate", s.now())
			}
		} else if d.PublicKey != key {
			return d, fmt.Errorf("installation_revoked")
		}
	case "heartbeat":
		if probeErr != nil {
			_, err = tx.ExecContext(ctx, "UPDATE registered_servers SET last_seen_at=$2,last_verified_at=NULL,last_error=$3,compatible=$4 WHERE id=$1", id, s.now(), probeErr.Error(), probeErr.Error() != "incompatible_server" && d.Compatible)
		} else {
			origin := d.Origin
			candidate := d.CandidateOrigin
			message := ""
			if candidateOK {
				origin = candidate
				candidate = ""
			} else if candidate != "" {
				message = "candidate_origin_verification_failed"
			}
			_, err = tx.ExecContext(ctx, "UPDATE registered_servers SET origin=$2,candidate_origin=$3,last_seen_at=$4,last_verified_at=$4,compatible=TRUE,last_error=$5,verified_contract=$6 WHERE id=$1", id, origin, candidate, s.now(), message, s.contractStamp())
		}
	case "ack":
		if input.Revision != d.Revision {
			return d, fmt.Errorf("stale_revision")
		}
		_, err = tx.ExecContext(ctx, `UPDATE registered_servers SET applied_revision=revision,status='active',owner_id=CASE WHEN transfer_accepted THEN transfer_to ELSE owner_id END,transfer_to=CASE WHEN transfer_accepted THEN NULL ELSE transfer_to END,transfer_expires_at=CASE WHEN transfer_accepted THEN NULL ELSE transfer_expires_at END,transfer_accepted=FALSE WHERE id=$1`, id)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return d, err
	}
	if input.Action != "ack" {
		s.observeRelease(id, key, observedOrigin, observed, checkedAt)
	}
	return s.readServer(ctx, s.DB, id, false)
}

func registryProblem(err error) (string, bool) {
	code := err.Error()
	switch code {
	case "invalid_pairing_code", "installation_revoked", "server_not_found", "invalid_registry_action":
		return code, false
	case "verification_unavailable", "transfer_pending", "retry_registry_operation", "stale_revision", "invalid_origin", "dns_unavailable", "non_public_origin", "https_unreachable", "invalid_https_probe", "invalid_probe_signature", "incompatible_server", "wss_unreachable", "invalid_wss_probe", "verification_busy":
		return code, true
	default:
		return "registry_unavailable", true
	}
}
