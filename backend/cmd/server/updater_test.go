package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"baboreborn/backend/server/hosting"
)

func TestUpdaterCredentialIsPrivateAndRotatesWithTheProcess(t *testing.T) {
	rooms := hosting.New(context.Background(), nil, nil, 1)
	file := filepath.Join(t.TempDir(), "updater-auth")
	configure := func() string {
		t.Helper()
		if err := configureUpdater(rooms, file); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(file)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("credential file permissions: %v, %v", info, err)
		}
		data, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(strings.TrimPrefix(string(data), "Authorization: "))
	}
	request := func(auth string) int {
		r := httptest.NewRequest(http.MethodPost, "/maintenance/drain", nil)
		r.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		rooms.ServeHTTP(w, r)
		return w.Code
	}
	previous := configure()
	if request(previous) != http.StatusNoContent {
		t.Fatal("credential file did not authorize drain")
	}
	current := configure()
	if previous == current || request(previous) != http.StatusForbidden || request(current) != http.StatusNoContent {
		t.Fatal("credential did not rotate")
	}
}
