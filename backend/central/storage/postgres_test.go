package storage

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"baboreborn/backend/internal/persistence"
)

func TestPostgresInitialBaselineBackupRestore(t *testing.T) {
	dsn := os.Getenv("BABOREBORN_TEST_POSTGRES")
	if dsn == "" {
		t.Skip("run make test-postgres for the isolated PostgreSQL gate")
	}
	if !strings.Contains(dsn, "/baboreborn_identity_test?") {
		t.Fatal("test requires the isolated identity test database")
	}
	ctx := context.Background()
	dir := t.TempDir()
	c, err := OpenCentral(ctx, dir, dsn, false)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := c.Close(); err != nil {
			t.Error(err)
		}
	}()
	if _, err := OpenCentral(ctx, t.TempDir(), dsn, false); err == nil {
		t.Fatal("second database owner admitted")
	}
	if _, err := c.DB.Exec("CREATE TABLE retained_data(value TEXT); INSERT INTO retained_data VALUES ('keep')"); err != nil {
		t.Fatal(err)
	}
	source := fstest.MapFS{"001_initial.sql": &fstest.MapFile{Data: []byte("CREATE TABLE rolled_back(id INTEGER); INVALID SQL")}}
	if err := persistence.Initialize(ctx, c.DB, "postgres", source, func() error { t.Fatal("unrecognized database modified"); return nil }); err == nil || !strings.Contains(err.Error(), "unrecognized database schema") {
		t.Fatalf("unrecognized database admitted: %v", err)
	}
	var retained string
	if err := c.DB.QueryRow("SELECT value FROM retained_data").Scan(&retained); err != nil || retained != "keep" {
		t.Fatal("unrecognized data changed", retained, err)
	}
	if _, err := c.DB.Exec("DROP TABLE retained_data"); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Initialize(ctx, c.DB, "postgres", source, func() error { return c.Backup(ctx, filepath.Join(t.TempDir(), "before.dump")) }); err == nil {
		t.Fatal("invalid initial schema succeeded")
	}
	var exists bool
	if err := c.DB.QueryRow("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f'))").Scan(&exists); err != nil || exists {
		t.Fatalf("partial initial schema: %v %v", exists, err)
	}
	entries, err := fs.ReadDir(migrations, "migrations/postgres")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "001_initial.sql" {
		t.Fatalf("initial baseline: %v", entries)
	}
	baseline, err := fs.Sub(migrations, "migrations/postgres")
	if err != nil {
		t.Fatal(err)
	}
	if err := persistence.Initialize(ctx, c.DB, "postgres", baseline, func() error { return c.Backup(ctx, filepath.Join(t.TempDir(), "initial.dump")) }); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Initialize(ctx, c.DB, "postgres", baseline, func() error { t.Fatal("initialized current schema again"); return nil }); err != nil {
		t.Fatal(err)
	}
	var application string
	var version, count int
	if err := c.DB.QueryRow("SELECT application FROM schema_identity").Scan(&application); err != nil || application != persistence.SchemaApplication {
		t.Fatalf("application identity: %q %v", application, err)
	}
	if err := c.DB.QueryRow("SELECT MAX(version), COUNT(*) FROM schema_migrations").Scan(&version, &count); err != nil || version != 1 || count != 1 {
		t.Fatalf("initial schema: version=%d count=%d %v", version, count, err)
	}
	for _, query := range []string{
		"SELECT last_seen_at,last_verified_at,transfer_expires_at FROM registered_servers LIMIT 0",
		"SELECT nonce_key FROM pairing_codes LIMIT 0",
		"SELECT server_id,purpose,request_id,expires_at,consumed_at FROM registry_nonces LIMIT 0",
	} {
		rows, err := c.DB.Query(query)
		if err != nil {
			t.Fatalf("current schema: %v", err)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.DB.Exec("INSERT INTO accounts VALUES ('test-account', CURRENT_TIMESTAMP)"); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "central.dump")
	if err := c.Backup(ctx, backup); err != nil {
		t.Fatal(err)
	}
	if _, err := c.DB.Exec("DELETE FROM accounts"); err != nil {
		t.Fatal(err)
	}
	corrupt := filepath.Join(t.TempDir(), "broken.dump")
	if err := os.WriteFile(corrupt, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := c.Restore(ctx, corrupt); err == nil {
		t.Fatal("corrupt restore succeeded")
	}
	if err := c.DB.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed restore changed data: %d %v", count, err)
	}
	if err := c.Restore(ctx, backup); err != nil {
		t.Fatal(err)
	}
	if err := c.DB.QueryRow("SELECT COUNT(*) FROM accounts").Scan(&count); err != nil || count != 1 {
		t.Fatalf("restored accounts: %d %v", count, err)
	}
	var future int
	if err := c.DB.QueryRow("SELECT MAX(version)+1 FROM schema_migrations").Scan(&future); err != nil {
		t.Fatal(err)
	}
	if _, err := c.DB.Exec("INSERT INTO schema_migrations VALUES ($1)", future); err != nil {
		t.Fatal(err)
	}
	if err := persistence.Initialize(ctx, c.DB, "postgres", fstest.MapFS{"001_initial.sql": &fstest.MapFile{Data: []byte("SELECT 1")}}, func() error { t.Fatal("backed up unsupported schema"); return nil }); err == nil || !strings.Contains(err.Error(), "unsupported database schema") {
		t.Fatalf("unsupported schema: %v", err)
	}
	if _, err := c.DB.Exec("DELETE FROM schema_migrations WHERE version=$1", future); err != nil {
		t.Fatal(err)
	}

	if _, err = c.DB.Exec("UPDATE schema_identity SET application='unsupported'"); err != nil {
		t.Fatal(err)
	}
	if err = persistence.Initialize(ctx, c.DB, "postgres", baseline, func() error { t.Fatal("unrecognized database modified"); return nil }); err == nil || !strings.Contains(err.Error(), "unrecognized database schema") {
		t.Fatal(err)
	}
	if _, err = c.DB.Exec("DROP TABLE schema_identity"); err != nil {
		t.Fatal(err)
	}
	if err = persistence.Initialize(ctx, c.DB, "postgres", baseline, func() error { t.Fatal("unrecognized database modified"); return nil }); err == nil || !strings.Contains(err.Error(), "unrecognized database schema") {
		t.Fatal(err)
	}
	if err = c.DB.QueryRow("SELECT count(*) FROM accounts").Scan(&count); err != nil || count != 1 {
		t.Fatal("unrecognized data changed", count, err)
	}
	// Restore the isolated test database for subsequent central integration tests.
	if err = c.Restore(ctx, backup); err != nil {
		t.Fatal(err)
	}

}
