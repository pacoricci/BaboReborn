package administration

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/transport"
)

func (s *Service) createRoom(ctx context.Context, actor, actorRole string, config hosting.Config) (id string, err error) {
	if rank(actorRole) < 2 {
		return "", fmt.Errorf("admin_required")
	}
	if len(s.Rooms.Directory().Rooms) >= s.Rooms.Directory().MaxRooms {
		return "", fmt.Errorf("room_limit_reached")
	}
	prepared, err := s.Rooms.Prepare(ctx, config)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", errStorageUnavailable
	}
	defer rollback(tx, &err)
	id = identity.ID()
	_, err = tx.ExecContext(ctx, "INSERT INTO rooms(id,configuration,actor,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)", id, string(data), actor, "", s.now().Unix())
	if err != nil {
		return "", errStorageWrite
	}
	if err = event(ctx, tx, actor, id, "room_create", "", s.now().Unix(), config); err != nil {
		return "", errStorageWrite
	}
	if err = tx.Commit(); err != nil {
		return "", errStorageCommit
	}
	return id, s.Rooms.Install(id, prepared)
}

// A metadata-only endpoint cannot accidentally apply stale gameplay settings.
func (s *Service) renameRoom(ctx context.Context, actor, actorRole, id, name string) (err error) {
	if rank(actorRole) < 2 {
		return fmt.Errorf("admin_required")
	}
	if s.pending[id] != nil {
		return errOperationPending
	}
	var raw string
	if err = s.DB.QueryRowContext(ctx, "SELECT configuration FROM rooms WHERE id=$1", id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("room_not_found")
		}
		return errStorageRead
	}
	var config hosting.Config
	if err = json.Unmarshal([]byte(raw), &config); err != nil {
		return errStorageRead
	}
	previous := config.Name
	config.Name = strings.TrimSpace(name)
	if err = s.Rooms.Validate(config); err != nil {
		return err
	}
	if config.Name == previous {
		return nil
	}
	data, err := json.Marshal(config)
	if err != nil {
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer rollback(tx, &err)
	if _, err = tx.ExecContext(ctx, "UPDATE rooms SET configuration=$1,actor=$2,reason=$3,updated_at=$4 WHERE id=$5", string(data), actor, "Room renamed", s.now().Unix(), id); err != nil {
		return errStorageWrite
	}
	if err = event(ctx, tx, actor, id, "room_rename", "Room renamed", s.now().Unix(), map[string]string{"previous": previous, "name": config.Name}); err != nil {
		return errStorageWrite
	}
	if err = tx.Commit(); err != nil {
		return errStorageCommit
	}
	return s.Rooms.Rename(id, config.Name)
}
func (s *Service) scheduleRoom(ctx context.Context, actor, actorRole, id string, config hosting.Config, closeRoom bool, session string) (Operation, error) {
	if rank(actorRole) < 2 {
		return Operation{}, fmt.Errorf("admin_required")
	}
	if s.pending[id] != nil {
		return Operation{}, errOperationPending
	}
	var exists int
	if err := s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM rooms WHERE id=$1", id).Scan(&exists); err != nil || exists != 1 {
		return Operation{}, fmt.Errorf("room_not_found")
	}
	var prepared *transport.Server
	if !closeRoom {
		var err error
		prepared, err = s.Rooms.Prepare(ctx, config)
		if err != nil {
			return Operation{}, err
		}
	}
	action := transport.NoticeRestart
	if closeRoom {
		action = transport.NoticeClose
	}
	op := &Operation{Session: session, ID: identity.ID(), Room: id, Actor: actor, Action: action, Status: "warning", DeadlineAt: s.now().Add(s.Warning)}
	notice := transport.Notice{Action: action, Deadline: op.DeadlineAt, Operation: op.ID}
	if err := s.Rooms.NotifyRoom(ctx, id, notice); err != nil {
		return Operation{}, err
	}
	if len(s.operations) >= 512 {
		for key, old := range s.operations {
			if old.Status != "warning" {
				delete(s.operations, key)
			}
		}
	}
	s.pending[id] = op
	s.operations[op.ID] = op
	go func() {
		timer := time.NewTimer(s.Warning)
		defer timer.Stop()
		select {
		case <-s.ctx.Done():
			return
		case <-timer.C:
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		defer delete(s.pending, id)
		bounded, cancel := context.WithTimeout(s.ctx, 5*time.Second)
		defer cancel()
		current, err := role(bounded, s.DB, actor)
		if err == nil && rank(current) < 2 {
			err = fmt.Errorf("permission_revoked")
		}
		if err == nil && !s.Access.ValidSession(op.Session, actor) {
			err = fmt.Errorf("session_ended")
		}
		if err == nil {
			var banned bool
			banned, err = s.blocked(bounded, actor)
			if err == nil && banned {
				err = fmt.Errorf("sanction_active")
			}
		}
		if err == nil {
			err = s.finishRoom(bounded, op, config, prepared)
		}
		if err != nil {
			op.Status = "failed"
			op.Error = err.Error()
			if err := s.Rooms.NotifyRoom(bounded, id, transport.Notice{Action: transport.NoticeCancelled, Operation: op.ID}); err != nil {
				log.Printf("Room cancellation notification failed: %v", err)
			}
		} else {
			op.Status = "applied"
		} //nolint:errcheck // A disconnected client can read the operation result over HTTP.
	}()
	return *op, nil
}
func (s *Service) finishRoom(ctx context.Context, op *Operation, config hosting.Config, prepared *transport.Server) (err error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return errStorageUnavailable
	}
	defer rollback(tx, &err)
	if op.Action == transport.NoticeClose {
		_, err = tx.ExecContext(ctx, "DELETE FROM rooms WHERE id=$1", op.Room)
	} else {
		var data []byte
		data, err = json.Marshal(config)
		if err == nil {
			_, err = tx.ExecContext(ctx, "UPDATE rooms SET configuration=$1,actor=$2,reason=$3,updated_at=$4 WHERE id=$5", string(data), op.Actor, "", s.now().Unix(), op.Room)
		}
	}
	if err != nil {
		return errStorageWrite
	}
	if err = event(ctx, tx, op.Actor, op.Room, "room_"+string(op.Action), "", s.now().Unix(), config); err != nil {
		return errStorageWrite
	}
	if err = tx.Commit(); err != nil {
		return errStorageCommit
	}
	applyContext, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	if err = s.Rooms.Remove(applyContext, op.Room, op.Action != transport.NoticeClose); err != nil {
		return err
	}
	if op.Action != transport.NoticeClose {
		return s.Rooms.Install(op.Room, prepared)
	}
	return nil
}
