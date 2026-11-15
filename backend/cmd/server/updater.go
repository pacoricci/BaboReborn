package main

import (
	"os"

	"baboreborn/backend/identity"
	"baboreborn/backend/server/hosting"
)

func configureUpdater(rooms *hosting.Manager, authFile string) error {
	token := identity.Random()
	// curl reads the header inside the container; it never enters command output
	// or the public API. Rotate it whenever the serving process starts.
	if err := os.WriteFile(authFile, []byte("Authorization: Bearer "+token+"\n"), 0600); err != nil {
		return err
	}
	rooms.SetUpdaterToken(token)
	return nil
}
