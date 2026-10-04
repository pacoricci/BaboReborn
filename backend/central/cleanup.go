package central

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"
)

const (
	cleanupInterval  = time.Minute
	cleanupTimeout   = 5 * time.Second
	cleanupBatchSize = 500
)

// No post-expiry retention: revoked sessions remain until their original expiry.
// Each table gets one batch so a flow backlog cannot starve session cleanup.
func (s *Service) cleanupExpired(ctx context.Context) (flows, sessions int64, err error) {
	ctx, cancel := context.WithTimeout(ctx, cleanupTimeout)
	defer cancel()
	cutoff := s.now()
	for _, table := range []struct {
		name, key string
		count     *int64
	}{
		{"oidc_flows", "state_hash", &flows}, {"sessions", "id", &sessions},
	} {
		// Skip rows held by callback/logout transactions; retry them next pass.
		query := fmt.Sprintf(`WITH expired AS (
   SELECT %s FROM %s WHERE expires_at <= $1 ORDER BY expires_at
   LIMIT $2 FOR UPDATE SKIP LOCKED
  ) DELETE FROM %s AS target USING expired WHERE target.%s = expired.%s`, table.key, table.name, table.name, table.key, table.key)
		result, e := s.DB.ExecContext(ctx, query, cutoff, cleanupBatchSize)
		if e == nil {
			*table.count, e = result.RowsAffected()
		}
		if e != nil {
			err = errors.Join(err, fmt.Errorf("%s: %w", table.name, e))
		}
	}
	return
}

// RunCleanup is owned and joined by the composition root before closing storage.
func (s *Service) RunCleanup(ctx context.Context) {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	s.runCleanup(ctx, ticker.C, log.Printf)
}

func (s *Service) runCleanup(ctx context.Context, ticks <-chan time.Time, report func(string, ...any)) {
	for {
		if ctx.Err() != nil {
			return
		}
		started := time.Now()
		flows, sessions, err := s.cleanupExpired(ctx)
		if ctx.Err() != nil {
			return
		}
		// Counts and duration make even empty passes observable without credentials.
		report("identity cleanup: flows=%d sessions=%d duration=%s error=%v", flows, sessions, time.Since(started), err)
		select {
		case <-ctx.Done():
			return
		case <-ticks:
		}
	}
}
