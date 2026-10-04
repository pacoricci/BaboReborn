package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
)

// Initialize installs the complete initial schema in an empty database. The backup
// must succeed before the transaction, and schema metadata commits with the schema.
func Initialize(ctx context.Context, db *sql.DB, dialect string, source fs.FS, backup func() error) (err error) {
	entries, err := fs.ReadDir(source, ".")
	if err != nil {
		return err
	}
	if len(entries) != 1 || entries[0].Name() != "001_initial.sql" || entries[0].IsDir() {
		return fmt.Errorf("schema source must contain only 001_initial.sql")
	}
	script, err := fs.ReadFile(source, "001_initial.sql")
	if err != nil {
		return err
	}
	var exists bool
	query := "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')"
	if dialect == "postgres" {
		query = "SELECT to_regclass('public.schema_migrations') IS NOT NULL"
	}
	if err = db.QueryRowContext(ctx, query).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ValidateSchema(ctx, db)
	}
	query = "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*')"
	if dialect == "postgres" {
		query = "SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f'))"
	}
	var populated bool
	if err = db.QueryRowContext(ctx, query).Scan(&populated); err != nil {
		return err
	}
	if populated {
		return fmt.Errorf("unrecognized database schema: use an empty database and data directory")
	}
	if err = backup(); err != nil {
		return fmt.Errorf("pre-initialization backup: %w", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, rollbackErr)
		}
	}()
	if _, err = tx.ExecContext(ctx, "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY CHECK(version > 0))"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "CREATE TABLE schema_identity(application TEXT PRIMARY KEY); INSERT INTO schema_identity VALUES ('"+SchemaApplication+"')"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, string(script)); err != nil {
		return fmt.Errorf("initial schema: %w", err)
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO schema_migrations(version) VALUES ($1)", SchemaVersion); err != nil {
		return err
	}
	return tx.Commit()
}

// ValidateSchema requires this application's complete baseline metadata.
func ValidateSchema(ctx context.Context, db *sql.DB) error {
	var application sql.NullString
	var count int
	if err := db.QueryRowContext(ctx, "SELECT MIN(application), COUNT(*) FROM schema_identity").Scan(&application, &count); err != nil || count != 1 || application.String != SchemaApplication {
		return fmt.Errorf("unrecognized database schema: use an empty database and data directory")
	}
	var version, versions int
	if err := db.QueryRowContext(ctx, "SELECT COALESCE(MAX(version),0), COUNT(*) FROM schema_migrations").Scan(&version, &versions); err != nil {
		return err
	}
	if version != SchemaVersion || versions != 1 {
		return fmt.Errorf("unsupported database schema: version %d with %d records; expected version %d with one record", version, versions, SchemaVersion)
	}
	return nil
}
