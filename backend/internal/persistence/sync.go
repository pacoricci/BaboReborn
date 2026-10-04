package persistence

import (
	"errors"
	"os"
)

func SyncFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(f.Sync(), f.Close())
}
func SyncDirectory(path string) error { return SyncFile(path) }
