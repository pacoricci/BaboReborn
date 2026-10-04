// Package administration serializes durable policy changes outside all simulations.
package administration

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"baboreborn/backend/registry"
	"baboreborn/backend/server/access"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/transport"
)

type Service struct {
	mu         sync.Mutex
	DB         *sql.DB
	Access     *access.Manager
	Rooms      *hosting.Manager
	ctx        context.Context
	pending    map[string]*Operation
	operations map[string]*Operation
	Warning    time.Duration
	Now        func() time.Time
}
type Operation struct {
	Session    string                 `json:"-"`
	ID         string                 `json:"id"`
	Room       string                 `json:"room"`
	Actor      string                 `json:"-"`
	Action     transport.NoticeAction `json:"action"`
	Status     string                 `json:"status"`
	Error      string                 `json:"error,omitempty"`
	DeadlineAt time.Time              `json:"deadlineAt"`
}
type Role struct {
	Account   string    `json:"account"`
	Role      string    `json:"role"`
	Actor     string    `json:"actor"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type Sanction struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	Target    string     `json:"target"`
	Actor     string     `json:"actor"`
	Reason    string     `json:"reason"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt *time.Time `json:"expiresAt"`
	RevokedAt *time.Time `json:"revokedAt"`
	RevokedBy *string    `json:"revokedBy"`
}
type Event struct {
	ID        int64           `json:"id"`
	Actor     string          `json:"actor"`
	Target    string          `json:"target"`
	Action    string          `json:"action"`
	Reason    string          `json:"reason"`
	CreatedAt time.Time       `json:"createdAt"`
	Details   json.RawMessage `json:"details"`
}

func New(ctx context.Context, db *sql.DB, a *access.Manager, rooms *hosting.Manager) *Service {
	s := &Service{DB: db, Access: a, Rooms: rooms, ctx: ctx, pending: map[string]*Operation{}, operations: map[string]*Operation{}, Warning: 10 * time.Second}
	rooms.SetAdmission(s.Admit)
	rooms.SetOrigin(a.Origin())
	a.Apply = rooms.Apply
	return s
}
func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}
func rank(role string) int {
	switch role {
	case "owner":
		return 3
	case "admin":
		return 2
	case "moderator":
		return 1
	}
	return 0
}
func role(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, subject string) (string, error) {
	if !strings.HasPrefix(subject, "account:") {
		return "player", nil
	}
	var owner string
	ownerErr := db.QueryRowContext(ctx, "SELECT owner_id FROM association WHERE singleton=1 AND removed=0").Scan(&owner)
	if ownerErr != nil && !errors.Is(ownerErr, sql.ErrNoRows) {
		return "", ownerErr
	}
	if owner != "" && owner == strings.TrimPrefix(subject, "account:") {
		return "owner", nil
	}
	var result string
	err := db.QueryRowContext(ctx, "SELECT role FROM roles WHERE account_id=$1", strings.TrimPrefix(subject, "account:")).Scan(&result)
	if errors.Is(err, sql.ErrNoRows) {
		return "player", nil
	}
	return result, err
}
func splitSubject(subject string) (string, string, error) {
	kind, id, ok := strings.Cut(subject, ":")
	if !ok || (kind != "account" && kind != "guest") || len(id) != 32 {
		return "", "", fmt.Errorf("invalid_target")
	}
	for _, c := range id {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return "", "", fmt.Errorf("invalid_target")
		}
	}
	return kind, id, nil
}
func (s *Service) Admit(r *http.Request, join func(transport.Identity) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Access.WithCurrent(r, func(who transport.Identity) error {
		blocked, err := s.blocked(r.Context(), who.Subject)
		if err != nil {
			return fmt.Errorf("admission_unavailable")
		}
		if blocked {
			return fmt.Errorf("sanction_active")
		}
		return join(who)
	})
}
func rollback(tx *sql.Tx, err *error) {
	if e := tx.Rollback(); e != nil && !errors.Is(e, sql.ErrTxDone) {
		*err = errors.Join(*err, e)
	}
}
func event(ctx context.Context, tx *sql.Tx, actor, target, action, why string, now int64, details any) error {
	data, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO events(actor,target,action,reason,created_at,details) VALUES($1,$2,$3,$4,$5,$6)", actor, target, action, why, now, string(data))
	return err
}
func putRole(ctx context.Context, tx *sql.Tx, id, value, actor string, now int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO roles(account_id,role,actor,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(account_id) DO UPDATE SET role=excluded.role,actor=excluded.actor,reason=excluded.reason,updated_at=excluded.updated_at`, id, value, actor, "", now)
	return err
}

// ApplyAssociation serializes ownership with administrative execution. The registry
// revision and its local audit record commit together, before acknowledging central.
func (s *Service) ApplyAssociation(ctx context.Context, d registry.Descriptor, key ed25519.PrivateKey) (err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer rollback(tx, &err)
	var owner string
	var revision int64
	var wasRemoved int
	if err = tx.QueryRowContext(ctx, "SELECT owner_id,revision,removed FROM association WHERE singleton=1").Scan(&owner, &revision, &wasRemoved); err != nil {
		return err
	}
	if d.Revision < revision {
		return fmt.Errorf("stale_association")
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	removed := 0
	if d.Status == "removed" {
		removed = 1
	}
	if _, err = tx.ExecContext(ctx, "UPDATE association SET private_key=$1,pending_key=NULL,pairing_code='',server_id=$2,owner_id=$3,revision=$4,descriptor=$5,removed=$6 WHERE singleton=1", []byte(key), d.ID, d.Owner, d.Revision, string(raw), removed); err != nil {
		return err
	}
	if owner != d.Owner {
		// Neither the old owner's privileges nor a prior appointment of the new owner
		// survive as an implicit administrative role after transfer.
		if _, err = tx.ExecContext(ctx, "DELETE FROM roles WHERE account_id IN ($1,$2)", owner, d.Owner); err != nil {
			return err
		}
	}
	if revision != d.Revision || owner != d.Owner || wasRemoved != removed {
		if err = event(ctx, tx, "central", "server:"+d.ID, "association", "Registry association applied", s.now().Unix(), map[string]any{"revision": d.Revision, "owner": d.Owner, "previousOwner": owner, "status": d.Status}); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if removed != 0 {
		return s.Rooms.Apply(ctx, transport.Administration{Action: transport.Disconnect, Code: transport.CloseRejected, Reason: transport.ReasonServerRemoved})
	}
	return nil
}
func (s *Service) Load(ctx context.Context) error {
	rows, err := s.DB.QueryContext(ctx, "SELECT id,configuration FROM rooms ORDER BY created_at,id")
	if err != nil {
		return err
	}
	type saved struct {
		id     string
		config hosting.Config
	}
	all := []saved{}
	for rows.Next() {
		var id, raw string
		if err = rows.Scan(&id, &raw); err != nil {
			break
		}
		var c hosting.Config
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			break
		}
		all = append(all, saved{id, c})
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return err
	}
	prepared := make([]*transport.Server, 0, len(all))
	if len(all) > s.Rooms.Directory().MaxRooms {
		return fmt.Errorf("stored rooms exceed configured limit")
	}
	for _, r := range all {
		room, err := s.Rooms.Prepare(ctx, r.config)
		if err != nil {
			return err
		}
		prepared = append(prepared, room)
	}
	for i, r := range all {
		if err := s.Rooms.Install(r.id, prepared[i]); err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			_, err := s.DB.ExecContext(ctx, "DELETE FROM events WHERE created_at <= $1", s.now().Add(-eventRetention).Unix())
			s.mu.Unlock()
			if err != nil && ctx.Err() != nil {
				return
			}
		}
	}
}

func (s *Service) blocked(ctx context.Context, subject string) (bool, error) {
	kind, id, err := splitSubject(subject)
	if err != nil {
		return false, err
	}
	// A transferred Owner must retain the ability to administer existing sanctions.
	if kind == "account" {
		current, err := role(ctx, s.DB, subject)
		if err != nil || current == "owner" {
			return false, err
		}
	}
	var count int
	err = s.DB.QueryRowContext(ctx, "SELECT COUNT(*) FROM sanctions WHERE identity_kind=$1 AND identity_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$3)", kind, id, s.now().Unix()).Scan(&count)
	return count > 0, err
}
