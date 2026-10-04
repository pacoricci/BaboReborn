package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"baboreborn/backend/internal/persistence"
)

type Local struct {
	DB        *sql.DB
	lease     *persistence.Lease
	Directory string
}

func OpenLocal(ctx context.Context, directory string) (_ *Local, err error) {
	lease, err := persistence.Acquire(directory)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, lease.Close())
		}
	}()
	path := filepath.Join(directory, "server.sqlite")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = f.Close(); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, db.Close())
		}
	}()
	db.SetMaxOpenConns(1)
	// DELETE journaling keeps offline replacement to a single database file. FULL
	// durability and a single connection serialize the small administrative workload.
	if _, err = db.ExecContext(ctx, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000"); err != nil {
		return nil, err
	}
	local := &Local{DB: db, lease: lease, Directory: directory}
	source, err := fs.Sub(migrations, "migrations/sqlite")
	if err != nil {
		return nil, err
	}
	err = persistence.Initialize(ctx, db, "sqlite", source, func() error {
		return local.Backup(ctx, filepath.Join(directory, fmt.Sprintf("before-initialize-%d.sqlite", time.Now().UnixNano())))
	})
	if err != nil {
		return nil, err
	}
	return local, nil
}
func (l *Local) Close() error { return errors.Join(l.DB.Close(), l.lease.Close()) }

// Backup refuses existing destinations and publishes only a complete snapshot.
func (l *Local) Backup(ctx context.Context, destination string) (err error) {
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".sqlite-backup-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	if err = temporary.Close(); err != nil {
		return err
	}
	defer func() {
		if e := os.Remove(name); e != nil && !os.IsNotExist(e) {
			err = errors.Join(err, e)
		}
	}()
	// VACUUM INTO requires an empty destination; SQLite handles the consistent copy.
	if _, err = l.DB.ExecContext(ctx, "VACUUM INTO '"+strings.ReplaceAll(name, "'", "''")+"'"); err != nil {
		return err
	}
	if err = persistence.SyncFile(name); err != nil {
		return err
	}
	if err = os.Link(name, destination); err != nil {
		return err
	}
	return persistence.SyncDirectory(filepath.Dir(destination))
}

// Restore validates a staged copy before atomically replacing the stopped server's
// database. A backup of the previous database remains available after replacement.
func RestoreLocal(ctx context.Context, directory, source string) (err error) {
	lease, err := persistence.Acquire(directory)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, lease.Close()) }()
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, input.Close()) }()
	stage, err := os.CreateTemp(directory, ".restore-*.sqlite")
	if err != nil {
		return err
	}
	stageName := stage.Name()
	defer func() {
		if e := os.Remove(stageName); e != nil && !os.IsNotExist(e) {
			err = errors.Join(err, e)
		}
	}()
	_, copyErr := io.Copy(stage, input)
	err = errors.Join(copyErr, stage.Sync(), stage.Close())
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite", stageName)
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	var integrity string
	err = db.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&integrity)
	if err == nil && integrity != "ok" {
		err = fmt.Errorf("backup integrity check: %s", integrity)
	}
	if err == nil {
		err = persistence.ValidateSchema(ctx, db)
	}
	// Integrity alone does not establish that the file belongs to this application.
	for _, query := range []string{
		"SELECT server_id,owner_id,private_key,pending_key,revision,descriptor FROM association LIMIT 0",
		"SELECT id,configuration,actor,reason,created_at,updated_at FROM rooms LIMIT 0",
		"SELECT account_id,role,actor,reason,created_at,updated_at FROM roles LIMIT 0",
		"SELECT id,identity_kind,identity_id,actor,reason,created_at,expires_at,revoked_at,revoked_by,revocation_reason FROM sanctions LIMIT 0",
		"SELECT id,actor,target,action,reason,created_at,details FROM events LIMIT 0",
	} {
		if err != nil {
			break
		}
		var rows *sql.Rows
		rows, err = db.QueryContext(ctx, query)
		if err == nil {
			err = rows.Close()
		}
	}
	err = errors.Join(err, db.Close())
	if err != nil {
		return err
	}
	target := filepath.Join(directory, "server.sqlite")
	// Refuse stale sidecars rather than let SQLite replay them over the restored file.
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(target + suffix); err == nil {
			return fmt.Errorf("database sidecar %s exists; recover it by reopening before restore", suffix)
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	if _, err := os.Stat(target); err == nil {
		if err = os.Link(target, filepath.Join(directory, fmt.Sprintf("before-restore-%d.sqlite", time.Now().UnixNano()))); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err = os.Rename(stageName, target); err != nil {
		return err
	}
	return persistence.SyncDirectory(directory)
}
