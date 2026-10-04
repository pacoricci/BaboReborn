package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"baboreborn/backend/internal/persistence"
)

type Central struct {
	DB        *sql.DB
	conn      *sql.Conn
	lease     *persistence.Lease
	directory string
	dsn       string
}

// A session advisory lock also excludes central processes using a different local
// directory against the same database. Keep its connection reserved for the lease.
func OpenCentral(ctx context.Context, directory, dsn string, initializeSchema bool) (_ *Central, err error) {
	if _, parseErr := postgresEnvironment(dsn); parseErr != nil {
		return nil, parseErr
	}
	if dsn == "" {
		return nil, fmt.Errorf("CENTRAL_DATABASE_URL is required")
	}
	lease, err := persistence.Acquire(directory)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, lease.Close())
		}
	}()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid PostgreSQL configuration")
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, db.Close())
		}
	}()
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to PostgreSQL")
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, conn.Close())
		}
	}()
	var acquired bool
	if err = conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(728436901)").Scan(&acquired); err != nil {
		return nil, err
	}
	if !acquired {
		return nil, fmt.Errorf("central database is in use; stop the central service first")
	}
	c := &Central{DB: db, conn: conn, lease: lease, directory: directory, dsn: dsn}
	if initializeSchema {
		var source fs.FS
		source, err = fs.Sub(migrations, "migrations/postgres")
		if err != nil {
			return nil, err
		}
		err = persistence.Initialize(ctx, db, "postgres", source, func() error {
			return c.Backup(ctx, filepath.Join(directory, fmt.Sprintf("before-initialize-%d.dump", time.Now().UnixNano())))
		})
		if err != nil {
			return nil, err
		}
	}
	return c, nil
}
func (c *Central) Close() error {
	// Closing the pool after returning this reserved connection terminates the
	// backend session, releasing its advisory lock even on an interrupted request.
	return errors.Join(c.conn.Close(), c.DB.Close(), c.lease.Close())
}
func (c *Central) Backup(ctx context.Context, destination string) (err error) {
	f, err := os.CreateTemp(filepath.Dir(destination), ".postgres-backup-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() {
		if e := os.Remove(name); e != nil && !os.IsNotExist(e) {
			err = errors.Join(err, e)
		}
	}()
	cmd := exec.CommandContext(ctx, "pg_dump", "--format=custom", "--no-owner", "--no-acl")
	// Pass connection fields through libpq environment variables, never argv or logs.
	cmd.Env, err = postgresEnvironment(c.dsn)
	if err != nil {
		return err
	}
	cmd.Stdout = f
	runErr := cmd.Run()
	err = errors.Join(f.Sync(), f.Close())
	if runErr != nil {
		return errors.Join(fmt.Errorf("pg_dump failed; check PostgreSQL client installation and connection"), err)
	}
	if err != nil {
		return err
	}
	if err = os.Link(name, destination); err != nil {
		return err
	}
	return persistence.SyncDirectory(filepath.Dir(destination))
}
func (c *Central) Restore(ctx context.Context, source string) error {
	if err := c.Backup(ctx, filepath.Join(c.directory, fmt.Sprintf("before-restore-%d.dump", time.Now().UnixNano()))); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "pg_restore", "--single-transaction", "--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", "", source)
	// Empty --dbname selects PGDATABASE without exposing it in the process list.
	environment, err := postgresEnvironment(c.dsn)
	if err != nil {
		return err
	}
	cmd.Env = environment
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pg_restore failed; transaction rolled back; service was not started")
	}
	return nil
}

// Restrict configuration to URL syntax so pgx and the backup tools use the same
// explicit connection settings, including TLS verification and client certificates.
func postgresEnvironment(dsn string) ([]string, error) {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return nil, fmt.Errorf("CENTRAL_DATABASE_URL must be a PostgreSQL URL")
	}
	values := map[string]string{"PGHOST": u.Hostname(), "PGPORT": u.Port(), "PGDATABASE": strings.TrimPrefix(u.Path, "/")}
	if u.User != nil {
		values["PGUSER"] = u.User.Username()
		if password, ok := u.User.Password(); ok {
			values["PGPASSWORD"] = password
		}
	}
	supported := map[string]string{"host": "PGHOST", "port": "PGPORT", "sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY", "connect_timeout": "PGCONNECT_TIMEOUT"}
	for key, list := range u.Query() {
		name, ok := supported[key]
		if !ok || len(list) != 1 {
			return nil, fmt.Errorf("unsupported PostgreSQL URL option")
		}
		values[name] = list[0]
	}
	environment := []string{}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "PG") {
			environment = append(environment, entry)
		}
	}
	for key, value := range values {
		if value != "" {
			environment = append(environment, key+"="+value)
		}
	}
	return environment, nil
}
