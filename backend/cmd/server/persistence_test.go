package main

import (
	"context"
	"testing"
	"time"

	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/storage"
	"baboreborn/backend/server/transport"
)

// Hold the only SQL connection while a write queues behind it. This validates
// the current composition boundary; repeat once administration commands exist.
func TestSimulationContinuesWhileStorageWaits(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	local, err := storage.OpenLocal(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := local.Close(); err != nil {
			t.Error(err)
		}
	}()
	conn, err := local.DB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := conn.Close(); err != nil {
			t.Error(err)
		}
	}()
	waiting := make(chan error, 1)
	go func() { _, err := local.DB.ExecContext(ctx, "DELETE FROM events"); waiting <- err }()
	server := transport.New(match.MustNew(testcontent.Map("yard")), 2, nil)
	done := make(chan struct{})
	go func() { server.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			t.Fatal("tick did not advance during blocked storage")
		case err := <-waiting:
			t.Fatalf("write did not block: %v", err)
		case <-ticker.C:
			if local.DB.Stats().WaitCount > 0 && server.Stats().Ticks >= 5 {
				return
			}
		}
	}
}
