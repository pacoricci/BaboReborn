package administration

import (
	"context"
	"fmt"
	"strings"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/server/transport"
)

func (s *Service) changeRole(ctx context.Context, actor, actorRole, account, next string) (err error) {
	if rank(actorRole) < 2 || (next != "admin" && next != "moderator" && next != "player") {
		return fmt.Errorf("role_change_refused")
	}
	if _, _, err = splitSubject("account:" + account); err != nil {
		return err
	}
	previous, err := role(ctx, s.DB, "account:"+account)
	if err != nil {
		return errStorageUnavailable
	}
	if previous == "owner" || rank(previous) >= rank(actorRole) || rank(next) >= rank(actorRole) {
		return fmt.Errorf("role_hierarchy_refused")
	}
	if err = s.Access.VerifyAccount(ctx, account); err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer rollback(tx, &err)
	if err = putRole(ctx, tx, account, next, actor, s.now().Unix()); err != nil {
		return errStorageWrite
	}
	if err = event(ctx, tx, actor, "account:"+account, "role", "", s.now().Unix(), map[string]string{"previous": previous, "role": next}); err != nil {
		return errStorageWrite
	}
	if err = tx.Commit(); err != nil {
		return errStorageCommit
	}
	return s.applyCommitted(transport.Administration{Action: transport.Notify, Notice: transport.Notice{Action: transport.NoticePermissionsChanged}})
}
func (s *Service) lower(ctx context.Context, actorRole, target string) error {
	if rank(actorRole) < 1 {
		return fmt.Errorf("staff_required")
	}
	if _, _, err := splitSubject(target); err != nil {
		return err
	}
	targetRole, err := role(ctx, s.DB, target)
	if err != nil {
		return errStorageUnavailable
	}
	if rank(targetRole) >= rank(actorRole) {
		return fmt.Errorf("role_hierarchy_refused")
	}
	return nil
}
func (s *Service) ban(ctx context.Context, actor, actorRole, target string, minutes int, why string) (err error) {
	why = strings.TrimSpace(why)
	if len(why) > 500 {
		return fmt.Errorf("reason_too_long")
	}
	if err = s.lower(ctx, actorRole, target); err != nil {
		return err
	}
	if minutes != 0 && minutes != 5 && minutes != 30 && minutes != 1440 {
		return fmt.Errorf("invalid_block_duration")
	}
	if minutes == 0 && rank(actorRole) < 2 {
		return fmt.Errorf("admin_required")
	}
	kind, id, _ := strings.Cut(target, ":")
	var expires *int64
	if minutes > 0 {
		v := s.now().Add(time.Duration(minutes) * time.Minute).Unix()
		expires = &v
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer rollback(tx, &err)
	sanction := identity.ID()
	_, err = tx.ExecContext(ctx, "INSERT INTO sanctions(id,identity_kind,identity_id,actor,reason,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)", sanction, kind, id, actor, why, s.now().Unix(), expires)
	if err != nil {
		return errStorageWrite
	}
	if err = event(ctx, tx, actor, target, "sanction", why, s.now().Unix(), map[string]any{"id": sanction, "expiresAt": expires}); err != nil {
		return errStorageWrite
	}
	if err = tx.Commit(); err != nil {
		return errStorageCommit
	}
	return s.applyCommitted(transport.Administration{Action: transport.Disconnect, Subject: target, Code: transport.CloseRemoved, Reason: transport.ReasonSanctionActive})
}
func (s *Service) revokeSanction(ctx context.Context, actor, actorRole, id string) (err error) {
	if rank(actorRole) < 1 {
		return fmt.Errorf("revocation_refused")
	}
	var kind, target, author string
	var expires *int64
	var revoked *int64
	err = s.DB.QueryRowContext(ctx, "SELECT identity_kind,identity_id,actor,expires_at,revoked_at FROM sanctions WHERE id=$1", id).Scan(&kind, &target, &author, &expires, &revoked)
	if err != nil {
		return fmt.Errorf("sanction_not_found")
	}
	if err = s.lower(ctx, actorRole, kind+":"+target); err != nil {
		return err
	}
	if rank(actorRole) < 2 && (expires == nil || author != actor) {
		return fmt.Errorf("revocation_refused")
	}
	if revoked != nil {
		return fmt.Errorf("already_revoked")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer rollback(tx, &err)
	_, err = tx.ExecContext(ctx, "UPDATE sanctions SET revoked_at=$1,revoked_by=$2,revocation_reason=$3 WHERE id=$4", s.now().Unix(), actor, "", id)
	if err != nil {
		return errStorageWrite
	}
	if err = event(ctx, tx, actor, kind+":"+target, "revoke_sanction", "", s.now().Unix(), map[string]string{"id": id}); err != nil {
		return errStorageWrite
	}
	if err = tx.Commit(); err != nil {
		return errStorageCommit
	}
	return nil
}
func (s *Service) kick(ctx context.Context, actor, actorRole, target string) (err error) {
	if err = s.lower(ctx, actorRole, target); err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer rollback(tx, &err)
	if err = event(ctx, tx, actor, target, "kick", "", s.now().Unix(), map[string]string{}); err != nil {
		return errStorageWrite
	}
	if err = tx.Commit(); err != nil {
		return errStorageCommit
	}
	return s.applyCommitted(transport.Administration{Action: transport.Disconnect, Subject: target, Code: transport.CloseRemoved, Reason: transport.ReasonKicked})
}

// Once committed, a disconnected HTTP caller cannot cancel session enforcement.
func (s *Service) applyCommitted(command transport.Administration) error {
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	return s.Rooms.Apply(ctx, command)
}
