package central

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"baboreborn/backend/identity"
)

func TestCleanupExpiryBatchesAndLogout(t *testing.T) {
	s := testService(t)
	now := s.now()
	ctx := context.Background()
	cookie, err := s.createSession(ctx, "issuer", "cleanup")
	if err != nil {
		t.Fatal(err)
	}
	var account string
	if err := s.DB.QueryRow("SELECT account_id FROM sessions").Scan(&account); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < cleanupBatchSize+1; i++ {
		expiry := now
		if i == 0 {
			expiry = now.Add(-time.Microsecond)
		}
		id := fmt.Sprint(i)
		if _, err := s.DB.Exec("INSERT INTO oidc_flows VALUES ($1,$1,'verifier','nonce','/', $2)", identity.Hash(id), expiry); err != nil {
			t.Fatal(err)
		}
		if _, err := s.DB.Exec("INSERT INTO sessions VALUES ($1,$2,$3,$4,$5,NULL)", id, identity.Hash(id), account, expiry.Add(-identity.SessionLifetime), expiry); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.DB.Exec("INSERT INTO oidc_flows VALUES ($1,$1,'verifier','nonce','/', $2)", identity.Hash("valid"), now.Add(time.Microsecond)); err != nil {
		t.Fatal(err)
	}
	expiry := now.Add(time.Microsecond)
	if _, err := s.DB.Exec("INSERT INTO sessions VALUES ('near-expiry',$1,$2,$3,$4,NULL)", identity.Hash("near-expiry"), account, expiry.Add(-identity.SessionLifetime), expiry); err != nil {
		t.Fatal(err)
	}
	for _, want := range []int64{cleanupBatchSize, 1, 0} {
		flows, sessions, err := s.cleanupExpired(ctx)
		if err != nil || flows != want || sessions != want {
			t.Fatalf("batch: %d %d %v; want %d", flows, sessions, err, want)
		}
	}
	request := httptest.NewRequest("POST", "/auth/logout", nil)
	request.AddCookie(&http.Cookie{Name: "central_session", Value: cookie})
	request.Header.Set("Origin", s.Origin)
	if _, err := s.session(request); err != nil {
		t.Fatal("valid session deleted", err)
	}
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, request)
	if response.Code != 303 {
		t.Fatal(response.Code)
	}
	if _, err := s.session(request); err == nil {
		t.Fatal("logout did not revoke")
	}
	if flows, sessions, err := s.cleanupExpired(ctx); err != nil || flows != 0 || sessions != 0 {
		t.Fatal(flows, sessions, err)
	}
	s.Now = func() time.Time { return now.Add(identity.SessionLifetime) }
	if flows, sessions, err := s.cleanupExpired(ctx); err != nil || flows != 1 || sessions != 2 {
		t.Fatal(flows, sessions, err)
	}
	if _, err := s.createSession(ctx, "issuer", "cleanup"); err != nil {
		t.Fatal("login after cleanup", err)
	}
}

func TestCleanupSkipsLockedRowsAndCancels(t *testing.T) {
	s := testService(t)
	if _, err := s.DB.Exec("INSERT INTO oidc_flows VALUES ($1,$1,'v','n','/', $2)", identity.Hash("locked"), s.now()); err != nil {
		t.Fatal(err)
	}
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func(tx *sql.Tx) {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			t.Error(err)
		}
	}(tx)
	if _, err := tx.Exec("SELECT * FROM oidc_flows FOR UPDATE"); err != nil {
		t.Fatal(err)
	}
	if flows, _, err := s.cleanupExpired(context.Background()); err != nil || flows != 0 {
		t.Fatal(flows, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if flows, _, err := s.cleanupExpired(context.Background()); err != nil || flows != 1 {
		t.Fatal(flows, err)
	}
	tx, err = s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func(tx *sql.Tx) {
		if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
			t.Error(err)
		}
	}(tx)
	if _, err := tx.Exec("LOCK TABLE oidc_flows IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, _, err := s.cleanupExpired(ctx); err == nil {
		t.Fatal("blocked cleanup ignored cancellation")
	}
	if time.Since(started) > time.Second {
		t.Fatal("slow cancellation")
	}
}

func TestCleanupLoopRetriesErrorsAndStops(t *testing.T) {
	s := testService(t)
	// A missing table simulates a persistent SQL failure, then is repaired between ticks.
	if _, err := s.DB.Exec("ALTER TABLE oidc_flows RENAME TO unavailable_flows"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time)
	reports := make(chan string, 3)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.runCleanup(ctx, ticks, func(format string, args ...any) { reports <- fmt.Sprintf(format, args...) })
	}()
	select {
	case message := <-reports:
		if !strings.Contains(message, "oidc_flows:") {
			t.Fatal("missing report")
		}
	case <-time.After(time.Second):
		t.Fatal("no initial pass")
	}
	if _, err := s.DB.Exec("ALTER TABLE unavailable_flows RENAME TO oidc_flows"); err != nil {
		t.Fatal(err)
	}
	ticks <- s.now()
	select {
	case message := <-reports:
		if !strings.Contains(message, "error=<nil>") {
			t.Fatal(message)
		}
	case <-time.After(time.Second):
		t.Fatal("no retry")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}
}
