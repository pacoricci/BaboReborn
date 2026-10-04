package central

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
)

func validNonceRequest(input registry.NonceRequest) bool {
	if !registry.ValidID(input.RequestID) {
		return false
	}
	switch input.Purpose {
	case "claim":
		return input.ServerID == "" && len(input.Code) == 43
	case "heartbeat", "ack", "publication":
		return registry.ValidID(input.ServerID) && input.Code == ""
	default:
		return false
	}
}

func (s *Service) nonceAssociation(ctx context.Context, db serverReader, key string, input registry.NonceRequest, lock bool) (string, string, error) {
	if input.Purpose == "claim" {
		query := `SELECT p.server_id,p.claimed_key,p.nonce_key,p.expires_at,d.transfer_to
			FROM pairing_codes p JOIN registered_servers d ON d.id=p.server_id
			WHERE p.credential_hash=$1`
		if lock {
			query += " FOR UPDATE OF p"
		}
		var serverID, claimed, pending string
		var expires time.Time
		var transfer sql.NullString
		err := db.QueryRowContext(ctx, query, identity.Hash(input.Code)).Scan(&serverID, &claimed, &pending, &expires, &transfer)
		if errors.Is(err, sql.ErrNoRows) {
			return "", "invalid_pairing_code", nil
		}
		if err != nil {
			return "", "", err
		}
		if claimed != "" && claimed != key || pending != "" && pending != key || claimed == "" && !expires.After(s.now()) {
			return "", "invalid_pairing_code", nil
		}
		if transfer.Valid && transfer.String != "" {
			return "", "transfer_pending", nil
		}
		return serverID, "", nil
	}
	var current, status string
	query := "SELECT public_key,status FROM registered_servers WHERE id=$1"
	if lock {
		query += " FOR UPDATE"
	}
	err := db.QueryRowContext(ctx, query, input.ServerID).Scan(&current, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "server_not_found", nil
	}
	if err != nil {
		return "", "", err
	}
	if current != key {
		return "", "installation_revoked", nil
	}
	if status == "removed" {
		return "", "server_removed", nil
	}
	if input.Purpose == "publication" && status != "active" {
		return "", "association_unavailable", nil
	}
	return input.ServerID, "", nil
}

func nonceFailure(w http.ResponseWriter, code string) {
	status, recoverable := http.StatusConflict, false
	if code == "transfer_pending" || code == "association_unavailable" {
		recoverable = true
	}
	identity.JSON(w, status, map[string]any{"error": code, "recoverable": recoverable})
}

func (s *Service) registryNonce(w http.ResponseWriter, r *http.Request) {
	var packet registry.Packet
	var input registry.NonceRequest
	if identity.Decode(w, r, &packet) != nil || packet.Verify(&input) != nil {
		identity.Error(w, http.StatusUnauthorized, "invalid_signature")
		return
	}
	if !validNonceRequest(input) {
		identity.Error(w, http.StatusBadRequest, "invalid_request")
		return
	}
	// Reject unknown installations before taking the shared issuance lock.
	preServerID, problem, err := s.nonceAssociation(r.Context(), s.DB, packet.Key, input, false)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	if problem != "" {
		nonceFailure(w, problem)
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	defer tx.Rollback() //nolint:errcheck // Commit owns success.
	if _, err = tx.ExecContext(r.Context(), "SELECT pg_advisory_xact_lock(731623)"); err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	if input.Purpose == "claim" {
		// Portal operations lock the server before its pairing code. Keep that order
		// while issuing a claim nonce so code regeneration cannot deadlock with us.
		var locked string
		err = tx.QueryRowContext(r.Context(), "SELECT id FROM registered_servers WHERE id=$1 FOR UPDATE", preServerID).Scan(&locked)
		if errors.Is(err, sql.ErrNoRows) {
			nonceFailure(w, "invalid_pairing_code")
			return
		}
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
	}
	serverID, problem, err := s.nonceAssociation(r.Context(), tx, packet.Key, input, true)
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	if problem != "" {
		nonceFailure(w, problem)
		return
	}
	if serverID != preServerID {
		nonceFailure(w, "invalid_pairing_code")
		return
	}
	now := s.now()
	if input.Purpose == "claim" {
		var result sql.Result
		result, err = tx.ExecContext(r.Context(), "UPDATE pairing_codes SET nonce_key=$1 WHERE credential_hash=$2 AND (nonce_key='' OR nonce_key=$1)", packet.Key, identity.Hash(input.Code))
		if err == nil {
			var changed int64
			changed, err = result.RowsAffected()
			if err == nil && changed != 1 {
				nonceFailure(w, "invalid_pairing_code")
				return
			}
		}
		if err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
	}
	if _, err = tx.ExecContext(r.Context(), "DELETE FROM registry_nonces WHERE expires_at<=$1", now); err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	var nonce, existingServer, existingPurpose string
	var consumed sql.NullTime
	err = tx.QueryRowContext(r.Context(), "SELECT nonce,server_id,purpose,consumed_at FROM registry_nonces WHERE public_key=$1 AND request_id=$2", packet.Key, input.RequestID).Scan(&nonce, &existingServer, &existingPurpose, &consumed)
	if err == nil {
		if existingServer != serverID || existingPurpose != input.Purpose || consumed.Valid {
			nonceFailure(w, "nonce_request_replayed")
			return
		}
		if err = tx.Commit(); err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		identity.JSON(w, http.StatusOK, map[string]string{"nonce": nonce})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	var count int
	for _, limit := range []struct {
		query string
		arg   any
		max   int
		code  string
	}{
		{"SELECT count(*) FROM registry_nonces WHERE public_key=$1 AND consumed_at IS NULL", packet.Key, maxLiveNoncesPerKey, "nonce_limit"},
		{"SELECT count(*) FROM registry_nonces WHERE server_id=$1 AND consumed_at IS NULL", serverID, maxLiveNoncesPerServer, "nonce_limit"},
		{"SELECT count(*) FROM registry_nonces WHERE server_id=$1", serverID, maxIssuedNoncesPerServer, "nonce_rate_limit"},
	} {
		if err = tx.QueryRowContext(r.Context(), limit.query, limit.arg).Scan(&count); err != nil {
			identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
			return
		}
		if count >= limit.max {
			identity.Error(w, http.StatusTooManyRequests, limit.code)
			return
		}
	}
	if err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM registry_nonces WHERE consumed_at IS NULL").Scan(&count); err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	if count >= maxLiveNoncesGlobal {
		identity.Error(w, http.StatusTooManyRequests, "registry_busy")
		return
	}
	nonce = identity.Random()
	_, err = tx.ExecContext(r.Context(), `INSERT INTO registry_nonces(nonce,public_key,server_id,purpose,request_id,expires_at)
		VALUES($1,$2,$3,$4,$5,$6)`, nonce, packet.Key, serverID, input.Purpose, input.RequestID, now.Add(nonceLifetime))
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "storage_unavailable")
		return
	}
	identity.JSON(w, http.StatusOK, map[string]string{"nonce": nonce})
}
