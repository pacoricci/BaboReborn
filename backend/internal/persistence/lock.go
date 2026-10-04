// Package persistence provides durability mechanisms shared by service-owned stores.
package persistence

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// Lease holds an OS lock until Close or process exit, including after a crash.
// The lock file is never unlinked: replacing its inode would permit two owners.
type Lease struct{ file *os.File }

func Acquire(directory string) (*Lease, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(directory, "process.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, errors.Join(fmt.Errorf("data directory is in use; stop the server first: %w", err), f.Close())
	}
	return &Lease{file: f}, nil
}
func (l *Lease) Close() error { return l.file.Close() }
