package central

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"baboreborn/backend/identity"
)

var errAccountOwnsServers = errors.New("account has server ownership or transfers")

func (s *Service) deleteAccount(w http.ResponseWriter, r *http.Request) {
	if !identity.SameOrigin(r, s.Origin) {
		identity.Error(w, http.StatusForbidden, "origin_refused")
		return
	}
	current, err := s.session(r)
	if err != nil {
		identity.Error(w, http.StatusUnauthorized, "login_required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, accountFormMaxBytes)
	if r.ParseForm() != nil || r.PostForm.Get("confirm") != "delete" || r.PostForm.Get("account") != current.Account {
		identity.Error(w, http.StatusBadRequest, "account_confirmation_required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), accountDeletionTimeout)
	defer cancel()
	err = s.eraseAccount(ctx, current)
	if errors.Is(err, errAccountOwnsServers) {
		http.Redirect(w, r, "/account?notice=account_has_servers", http.StatusSeeOther)
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		identity.Error(w, http.StatusUnauthorized, "login_required")
		return
	}
	if err != nil {
		identity.Error(w, http.StatusServiceUnavailable, "account_deletion_unavailable")
		return
	}
	identity.Cookie(w, "central_session", "signed-out", !s.Development, int(identity.SessionLifetime.Seconds()))
	http.Redirect(w, r, "/account?notice=account_deleted", http.StatusSeeOther)
}

// Erase only central's records. Independent community storage and existing access
// proofs have their own lifecycle; deleting an account does not recall a signed proof.
func (s *Service) eraseAccount(ctx context.Context, current session) (err error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx, &err)
	var account string
	// New sessions, ownership and invitations wait on the account's foreign key,
	// so they cannot recreate a reference after the deletion commits.
	err = tx.QueryRowContext(ctx, `SELECT a.id FROM accounts a JOIN sessions s ON s.account_id=a.id
		WHERE a.id=$1 AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>$3 FOR UPDATE OF a`, current.Account, current.ID, s.now()).Scan(&account)
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT status FROM registered_servers
		WHERE owner_id=$1 OR transfer_to=$1 ORDER BY id FOR UPDATE`, account)
	if err != nil {
		return err
	}
	blocked := false
	for rows.Next() {
		var status string
		if err = rows.Scan(&status); err != nil {
			break
		}
		blocked = blocked || status != "removed"
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return err
	}
	if blocked {
		return errAccountOwnsServers
	}
	for _, query := range []string{
		"DELETE FROM pairing_codes WHERE server_id IN (SELECT id FROM registered_servers WHERE owner_id=$1)",
		"DELETE FROM registry_nonces WHERE server_id IN (SELECT id FROM registered_servers WHERE owner_id=$1)",
		"DELETE FROM registry_events WHERE server_id IN (SELECT id FROM registered_servers WHERE owner_id=$1)",
		"DELETE FROM registered_servers WHERE owner_id=$1",
		"UPDATE registered_servers SET transfer_to=NULL,transfer_expires_at=NULL,transfer_accepted=FALSE WHERE transfer_to=$1",
		// Preserve other operators' server history without this account's identifier.
		"UPDATE registry_events SET actor='deleted-account' WHERE actor=$1",
		"DELETE FROM sessions WHERE account_id=$1",
		"DELETE FROM external_identities WHERE account_id=$1",
		"DELETE FROM accounts WHERE id=$1",
	} {
		if _, err = tx.ExecContext(ctx, query, account); err != nil {
			return err
		}
	}
	return tx.Commit()
}
