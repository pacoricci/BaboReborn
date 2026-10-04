package storage

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"testing"
	"time"

	"baboreborn/backend/internal/persistence"
)

func TestCrashReleasesLeaseAndRollsBack(t *testing.T) {
	if directory := os.Getenv("BABOREBORN_CRASH_DIRECTORY"); directory != "" {
		local := openTest(t, directory)
		tx, err := local.DB.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec("INSERT INTO roles VALUES ('uncommitted','admin','operator','interrupted',1,1)"); err != nil {
			t.Fatal(err)
		}
		if _, err := fmt.Fprintln(os.Stdout, "transaction-ready"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Hour)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	directory := t.TempDir()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCrashReleasesLeaseAndRollsBack$")
	child.Env = append(os.Environ(), "BABOREBORN_CRASH_DIRECTORY="+directory)
	out, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(out)
	if !scanner.Scan() || scanner.Text() != "transaction-ready" {
		if err := child.Wait(); err != nil {
			t.Log("child exited before transaction")
		}
		t.Fatal("child did not begin transaction")
	}
	if _, err := persistence.Acquire(directory); err == nil {
		t.Fatal("acquired running process lease")
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err == nil {
		t.Fatal("expected killed child")
	}
	local := openTest(t, directory)
	defer closeTest(t, local)
	var count int
	if err := local.DB.QueryRow("SELECT COUNT(*) FROM roles").Scan(&count); err != nil || count != 0 {
		t.Fatalf("crash leaked transaction: %d %v", count, err)
	}
}
