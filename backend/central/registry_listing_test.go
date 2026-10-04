package central

import (
	"context"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/registry"
)

type catalogQueryCounter struct{ count atomic.Int64 }

func (c *catalogQueryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "FROM registered_servers") {
		c.count.Add(1)
	}
	return ctx
}
func (*catalogQueryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestCatalogSingleQueryAndProjection(t *testing.T) {
	s := testService(t)
	cookie, owner := accountCookie(t, s, "catalog-owner")
	_, recipient := accountCookie(t, s, "catalog-recipient")
	s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
	ctx := context.Background()
	_, err := s.DB.ExecContext(ctx, `INSERT INTO registered_servers
 (id,owner_id,name,region,origin,operation_id,status,applied_revision,compatible,verified_contract,last_seen_at,last_verified_at)
 SELECT 'server-'||n,$1,'Community','EU','https://server-'||n||'.example.org','operation','active',1,TRUE,$2,$3,$3
 FROM generate_series(1,1000) AS n`, owner, s.contractStamp(), s.now())
	if err != nil {
		t.Fatal(err)
	}
	// Keep each exclusion independent so a missing presence or compatibility check is visible.
	for _, query := range []string{
		"UPDATE registered_servers SET status='removed' WHERE id='server-1'",
		"UPDATE registered_servers SET status='pending' WHERE id='server-2'",
		"UPDATE registered_servers SET applied_revision=0 WHERE id='server-3'",
		"UPDATE registered_servers SET compatible=FALSE WHERE id='server-4'",
		"UPDATE registered_servers SET verified_contract='old' WHERE id='server-5'",
		"UPDATE registered_servers SET last_seen_at=NULL WHERE id='server-6'",
		"UPDATE registered_servers SET last_verified_at=NULL WHERE id='server-7'",
	} {
		if _, err := s.DB.ExecContext(ctx, query); err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"last_seen_at", "last_verified_at"} {
		id := "server-8"
		if column == "last_verified_at" {
			id = "server-9"
		}
		if _, err := s.DB.ExecContext(ctx, "UPDATE registered_servers SET "+column+"=$1 WHERE id=$2", s.now().Add(-registry.Presence), id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.DB.ExecContext(ctx, "UPDATE registered_servers SET transfer_to=$1 WHERE id='server-2'", recipient); err != nil {
		t.Fatal(err)
	}
	config, err := pgx.ParseConfig(os.Getenv("BABOREBORN_TEST_POSTGRES"))
	if err != nil {
		t.Fatal(err)
	}
	counter := &catalogQueryCounter{}
	config.Tracer = counter
	s.DB = stdlib.OpenDB(*config)
	t.Cleanup(func() {
		if err := s.DB.Close(); err != nil {
			t.Error(err)
		}
	})
	for _, tc := range []struct {
		name, account string
		want          int
	}{
		{"public", "", 991}, {"owner", owner, 999}, {"recipient", recipient, 1}, {"unrelated", "unknown", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			counter.count.Store(0)
			list, err := s.listServers(ctx, tc.account)
			if err != nil {
				t.Fatal(err)
			}
			if count := counter.count.Load(); count != 1 {
				t.Fatalf("catalog queries = %d, want 1", count)
			}
			if len(list) != tc.want {
				t.Fatalf("servers = %d, want %d", len(list), tc.want)
			}
			for i, d := range list {
				if i > 0 && list[i-1].ID >= d.ID {
					t.Fatal("unstable ordering")
				}
				single, err := s.readServer(ctx, s.DB, d.ID, false)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(single, d) {
					t.Fatalf("lookup/list mismatch for %s", d.ID)
				}
			}
		})
	}
	s.publications = map[string]publishedSnapshot{}
	servers, err := s.listServers(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range servers {
		s.publications[d.ID] = publishedSnapshot{Key: d.PublicKey, Received: s.now(), Publication: registry.Publication{Revision: d.Revision, Rooms: []registry.PublishedRoom{{ID: strings.Repeat("a", 32), Name: "Arena", Mode: "dm", Map: "Yard", Details: &registry.RoomDetails{MapID: "yard"}, Capacity: 16, Protocol: compatibility.Current().Protocol, Profile: compatibility.GameProfile()}}}}
	}
	counter.count.Store(0)
	status, body := portalRequest(t, s, "", "GET", "/api/v1/rooms", nil)
	if status != 200 || counter.count.Load() != 1 || strings.Count(string(body), `"ref":`) != 991 {
		t.Fatalf("global catalog: status %d, queries %d", status, counter.count.Load())
	}

	s.VerifierRegistry = nil
	list, err := s.listServers(ctx, "")
	if err != nil || len(list) != 0 {
		t.Fatalf("catalog without verifier: %v, %v", list, err)
	}
	for _, path := range []string{"/account", "/manage/servers"} {
		counter.count.Store(0)
		status, _ := portalRequest(t, s, cookie, "GET", path, nil)
		if status != 200 || counter.count.Load() != 0 {
			t.Fatalf("%s: status %d, catalog queries %d", path, status, counter.count.Load())
		}
	}
}

func TestAccountPagesDoNotRequireCatalog(t *testing.T) {
	// No cookie means no session query; a nil DB catches any accidental catalog access.
	s := &Service{}
	for _, path := range []string{"/account", "/manage/servers"} {
		response := httptest.NewRecorder()
		s.home(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 {
			t.Fatalf("%s: status %d", path, response.Code)
		}
	}
}
