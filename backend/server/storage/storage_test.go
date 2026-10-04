package storage

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"baboreborn/backend/internal/persistence"
)

func openTest(t *testing.T, directory string) *Local {
	t.Helper()
	l, err := OpenLocal(context.Background(), directory)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func closeTest(t *testing.T, l *Local) {
	t.Helper()
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
}
func seed(t *testing.T, l *Local) {
	t.Helper()
	_, err := l.DB.Exec(`INSERT INTO roles VALUES ('account-one','admin','operator','initial assignment',1,1);
INSERT INTO sanctions VALUES ('ban','account','account-two','account-one','permanent explanation',1,NULL,NULL,NULL,NULL);
INSERT INTO events VALUES (1,'account-one','account-two','ban','permanent explanation',1,'{}');
INSERT INTO rooms VALUES ('room-one','{}','account-one','created',1,1);
INSERT INTO association(singleton,central,private_key,server_id,owner_id,revision) VALUES(1,'https://portal.example',zeroblob(64),'stable-server','account-one',9);`)
	if err != nil {
		t.Fatal(err)
	}
}
func TestLocalRestartBackupRestoreAndExclusiveOwnership(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	l := openTest(t, dir)
	seed(t, l)
	if _, err := OpenLocal(ctx, dir); err == nil {
		t.Fatal("second owner admitted")
	}
	backup := filepath.Join(t.TempDir(), "snapshot.sqlite")
	if err := l.Backup(ctx, backup); err != nil {
		t.Fatal(err)
	}
	if err := l.Backup(ctx, backup); err == nil {
		t.Fatal("overwrote backup")
	}
	if err := RestoreLocal(ctx, dir, backup); err == nil {
		t.Fatal("restored live database")
	}
	closeTest(t, l)
	l = openTest(t, dir)
	var reason string
	if err := l.DB.QueryRow("SELECT reason FROM sanctions WHERE id='ban'").Scan(&reason); err != nil || reason != "permanent explanation" {
		t.Fatalf("reopen: %s %v", reason, err)
	}
	if _, err := l.DB.Exec("DELETE FROM rooms; DELETE FROM events"); err != nil {
		t.Fatal(err)
	}
	if err := l.DB.QueryRow("SELECT reason FROM sanctions WHERE id='ban'").Scan(&reason); err != nil {
		t.Fatal(err)
	}
	closeTest(t, l)
	corrupt := filepath.Join(t.TempDir(), "corrupt.sqlite")
	if err := os.WriteFile(corrupt, []byte("not a database"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := RestoreLocal(ctx, dir, corrupt); err == nil {
		t.Fatal("accepted corrupt backup")
	}
	l = openTest(t, dir)
	var count int
	if err := l.DB.QueryRow("SELECT COUNT(*) FROM rooms").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed restore changed data: %d %v", count, err)
	}
	closeTest(t, l)
	if err := RestoreLocal(ctx, dir, backup); err != nil {
		t.Fatal(err)
	}
	l = openTest(t, dir)
	defer closeTest(t, l)
	if err := l.DB.QueryRow("SELECT COUNT(*) FROM rooms").Scan(&count); err != nil || count != 1 {
		t.Fatalf("restored rooms: %d %v", count, err)
	}
	var serverID, owner string
	var revision, keyLength int
	if err := l.DB.QueryRow("SELECT server_id,owner_id,revision,length(private_key) FROM association").Scan(&serverID, &owner, &revision, &keyLength); err != nil || serverID != "stable-server" || owner != "account-one" || revision != 9 || keyLength != 64 {
		t.Fatal("backup lost installation identity", serverID, owner, revision, keyLength, err)
	}
	backups, err := filepath.Glob(filepath.Join(dir, "before-restore-*.sqlite"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("recovery backup: %v %v", backups, err)
	}
}
func TestInitializationFailureIsAtomicAndBackupRequired(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "schema.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	}()
	source := fstest.MapFS{
		"001_initial.sql": &fstest.MapFile{Data: []byte("CREATE TABLE should_rollback(id INTEGER); THIS IS INVALID SQL")},
	}
	backedUp := false
	err = persistence.Initialize(context.Background(), db, "sqlite", source, func() error { backedUp = true; return nil })
	if err == nil || !backedUp {
		t.Fatalf("initialization: %v backup=%v", err, backedUp)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial schema %d %v", count, err)
	}
	source["001_initial.sql"] = &fstest.MapFile{Data: []byte("CREATE TABLE should_rollback(id INTEGER)")}
	err = persistence.Initialize(context.Background(), db, "sqlite", source, func() error { return errors.New("disk full") })
	if err == nil || !strings.Contains(err.Error(), "disk full") {
		t.Fatalf("backup failure ignored: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("backup failure changed schema %d %v", count, err)
	}
}

func TestInitializationRequiresOneCompleteBaseline(t *testing.T) {
	for name, source := range map[string]fstest.MapFS{
		"empty source": {},
		"different file": {
			"schema.sql": &fstest.MapFile{Data: []byte("CREATE TABLE unexpected(id INTEGER)")},
		},
		"multiple files": {
			"001_initial.sql": &fstest.MapFile{Data: []byte("CREATE TABLE unexpected(id INTEGER)")},
			"002_schema.sql":  &fstest.MapFile{Data: []byte("SELECT 1")},
		},
	} {
		t.Run(name, func(t *testing.T) {
			db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "schema.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			}()
			if err := persistence.Initialize(context.Background(), db, "sqlite", source, func() error {
				t.Fatal("invalid schema source started initialization")
				return nil
			}); err == nil {
				t.Fatal("invalid schema source accepted")
			}
			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").Scan(&count); err != nil || count != 0 {
				t.Fatalf("invalid source changed schema: %d %v", count, err)
			}
		})
	}
}

func TestUnsupportedSchemaCannotOpenOrReplaceCurrentDatabase(t *testing.T) {
	dir := t.TempDir()
	l := openTest(t, dir)
	if _, err := l.DB.Exec("INSERT INTO schema_migrations VALUES (2)"); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "future.sqlite")
	if err := l.Backup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	closeTest(t, l)
	if _, err := OpenLocal(context.Background(), dir); err == nil || !strings.Contains(err.Error(), "unsupported database schema") {
		t.Fatalf("future schema: %v", err)
	}
	lease, err := persistence.Acquire(dir)
	if err != nil {
		t.Fatalf("failed startup leaked lease: %v", err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	currentDirectory := t.TempDir()
	l = openTest(t, currentDirectory)
	seed(t, l)
	closeTest(t, l)
	if err := RestoreLocal(context.Background(), currentDirectory, backup); err == nil || !strings.Contains(err.Error(), "unsupported database schema") {
		t.Fatalf("future backup: %v", err)
	}
	l = openTest(t, currentDirectory)
	defer closeTest(t, l)
	var count int
	if err := l.DB.QueryRow("SELECT COUNT(*) FROM rooms").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected future backup changed current data: %d %v", count, err)
	}
}

func TestInvalidSchemaMetadataIsRefusedWithoutChanges(t *testing.T) {
	for name, change := range map[string]string{
		"missing identity":    "DROP TABLE schema_identity",
		"unknown application": "UPDATE schema_identity SET application='unsupported'",
		"empty identity":      "DELETE FROM schema_identity",
		"multiple identities": "INSERT INTO schema_identity VALUES ('other-application')",
		"missing version":     "DELETE FROM schema_migrations",
		"missing metadata":    "DROP TABLE schema_migrations",
		"unsupported version": "UPDATE schema_migrations SET version=2",
	} {
		t.Run(name, func(t *testing.T) {
			directory := t.TempDir()
			local := openTest(t, directory)
			seed(t, local)
			if _, err := local.DB.Exec(change); err != nil {
				t.Fatal(err)
			}
			closeTest(t, local)
			if _, err := OpenLocal(context.Background(), directory); err == nil {
				t.Fatal("invalid schema metadata admitted")
			}
			db, err := sql.Open("sqlite", filepath.Join(directory, "server.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := db.Close(); err != nil {
					t.Error(err)
				}
			}()
			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM rooms").Scan(&count); err != nil || count != 1 {
				t.Fatalf("invalid metadata changed stored data: %d %v", count, err)
			}
		})
	}
}

func TestUnrecognizedLocalDatabaseIsRefusedWithoutChanges(t *testing.T) {
	directory := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(directory, "server.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE retained_data(value TEXT); INSERT INTO retained_data VALUES ('keep')"); err != nil {
		t.Fatal(err)
	}
	var tables int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_master").Scan(&tables); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenLocal(context.Background(), directory); err == nil || !strings.Contains(err.Error(), "unrecognized database schema") {
		t.Fatal("unrecognized database accepted", err)
	}
	db, err = sql.Open("sqlite", filepath.Join(directory, "server.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close() //nolint:errcheck // Read-only verification cleanup.
	var value string
	var after int
	if err = db.QueryRow("SELECT value FROM retained_data").Scan(&value); err != nil || value != "keep" {
		t.Fatal(value, err)
	}
	if err = db.QueryRow("SELECT count(*) FROM sqlite_master").Scan(&after); err != nil || after != tables {
		t.Fatal(tables, after, err)
	}
}

func TestIncompatibleIdentityCannotOpenOrReplaceCurrentDatabase(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	local := openTest(t, directory)
	seed(t, local)
	var count int
	closeTest(t, local)

	otherDirectory := t.TempDir()
	other := openTest(t, otherDirectory)
	if _, err := other.DB.Exec("UPDATE schema_identity SET application='unsupported'"); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(t.TempDir(), "incompatible.sqlite")
	if err := other.Backup(ctx, backup); err != nil {
		t.Fatal(err)
	}
	closeTest(t, other)
	if _, err := OpenLocal(ctx, otherDirectory); err == nil || !strings.Contains(err.Error(), "unrecognized database schema") {
		t.Fatalf("incompatible identity admitted: %v", err)
	}
	if err := RestoreLocal(ctx, directory, backup); err == nil || !strings.Contains(err.Error(), "unrecognized database schema") {
		t.Fatalf("incompatible backup accepted: %v", err)
	}
	local = openTest(t, directory)
	defer closeTest(t, local)
	if err := local.DB.QueryRow("SELECT COUNT(*) FROM rooms").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected backup changed current data: %d %v", count, err)
	}
}

func TestLocalBaselineCreatesCurrentSchemaAndReopens(t *testing.T) {
	directory := t.TempDir()
	entries, err := fs.ReadDir(migrations, "migrations/sqlite")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "001_initial.sql" {
		t.Fatalf("initial baseline: %v", entries)
	}
	local := openTest(t, directory)
	var application string
	var version, count int
	if err := local.DB.QueryRow("SELECT application FROM schema_identity").Scan(&application); err != nil || application != persistence.SchemaApplication {
		t.Fatalf("application identity: %q %v", application, err)
	}
	if err := local.DB.QueryRow("SELECT MAX(version), COUNT(*) FROM schema_migrations").Scan(&version, &count); err != nil || version != 1 || count != 1 {
		t.Fatalf("initial schema: version=%d count=%d %v", version, count, err)
	}
	configuration := `{"name":"Timed","timeLimitMinutes":30}`
	if _, err := local.DB.Exec("INSERT INTO rooms VALUES ('timed',$1,'account-one','',1,1)", configuration); err != nil {
		t.Fatal(err)
	}
	if _, err := local.DB.Exec("INSERT INTO rooms VALUES ('invalid','invalid-json','account-one','',1,1)"); err == nil {
		t.Fatal("room accepted invalid configuration")
	}
	closeTest(t, local)
	local = openTest(t, directory)
	defer closeTest(t, local)
	var stored string
	if err := local.DB.QueryRow("SELECT configuration FROM rooms WHERE id='timed'").Scan(&stored); err != nil || stored != configuration {
		t.Fatalf("room configuration: %s %v", stored, err)
	}
	backups, err := filepath.Glob(filepath.Join(directory, "before-initialize-*.sqlite"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("reopen initialized schema again: %v %v", backups, err)
	}
}
