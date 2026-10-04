package administration

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestHTTPDatesPreserveStoredSanctionsAndAudit(t *testing.T) {
	f := setup(t)
	now := time.Now().In(time.FixedZone("test", 2*60*60)).Truncate(time.Second)
	f.s.Now = func() time.Time { return now }
	seconds := now.Unix()
	created := seconds - 600
	expires := seconds + 300
	revoked := seconds - 60
	if _, err := f.s.DB.Exec("INSERT INTO roles(account_id,role,actor,reason,created_at,updated_at) VALUES($1,'moderator',$2,'',0,$3)", modID, "account:"+ownerID, seconds); err != nil {
		t.Fatal(err)
	}
	guest := strings.Repeat("e", 32)
	for _, row := range []struct {
		id               string
		expires, revoked any
	}{
		{"temporary", expires, nil},
		{"permanent", nil, nil},
		{"revoked", seconds - 120, revoked},
	} {
		if _, err := f.s.DB.Exec("INSERT INTO sanctions(id,identity_kind,identity_id,actor,reason,created_at,expires_at,revoked_at) VALUES($1,'guest',$2,$3,'retained sanction',$4,$5,$6)", row.id, guest, "account:"+ownerID, created, row.expires, row.revoked); err != nil {
			t.Fatal(err)
		}
	}
	// The retained audit payload keeps its storage format and unrelated numeric data.
	details := fmt.Sprintf(`{"id":"temporary","expiresAt":%d,"other":9007199254740993}`, expires)
	if _, err := f.s.DB.Exec("INSERT INTO events(actor,target,action,reason,created_at,details) VALUES($1,$2,'sanction','',$3,$4)", "account:"+ownerID, "guest:"+guest, created, details); err != nil {
		t.Fatal(err)
	}
	read := func(path string, cookie bool) []map[string]json.RawMessage {
		t.Helper()
		who := f.owner
		if !cookie {
			who = nil
		}
		status, data := f.request(t, who, "GET", path, nil)
		if status != 200 {
			t.Fatal(path, status, string(data))
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(data, &rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	check := func(value json.RawMessage, want string) {
		t.Helper()
		var actual *string
		if err := json.Unmarshal(value, &actual); err != nil {
			t.Fatalf("date must be a string or null: %s: %v", value, err)
		}
		if want == "" {
			if actual != nil {
				t.Fatalf("date = %q, want null", *actual)
			}
		} else if actual == nil || *actual != want {
			t.Fatalf("date = %s, want %q", value, want)
		}
	}
	utc := now.UTC()
	roles := read("/api/v1/admin/roles", true)
	if len(roles) != 1 {
		t.Fatal("roles", len(roles))
	}
	check(roles[0]["createdAt"], "1970-01-01T00:00:00Z")
	check(roles[0]["updatedAt"], utc.Format(time.RFC3339))
	for _, path := range []string{"/api/v1/admin/sanctions", "/api/v1/me/sanctions"} {
		rows := read(path, path == "/api/v1/admin/sanctions")
		if len(rows) != 3 {
			t.Fatal(path, len(rows))
		}
		for _, row := range rows {
			check(row["createdAt"], utc.Add(-10*time.Minute).Format(time.RFC3339))
			var id string
			if err := json.Unmarshal(row["id"], &id); err != nil {
				t.Fatal(err)
			}
			switch id {
			case "temporary":
				check(row["expiresAt"], utc.Add(5*time.Minute).Format(time.RFC3339))
				check(row["revokedAt"], "")
			case "permanent":
				check(row["expiresAt"], "")
				check(row["revokedAt"], "")
			case "revoked":
				check(row["expiresAt"], utc.Add(-2*time.Minute).Format(time.RFC3339))
				check(row["revokedAt"], utc.Add(-time.Minute).Format(time.RFC3339))
			default:
				t.Fatal("unexpected sanction", id)
			}
		}
	}
	events := read("/api/v1/admin/events", true)
	if len(events) != 1 {
		t.Fatal("events", len(events))
	}
	check(events[0]["createdAt"], utc.Add(-10*time.Minute).Format(time.RFC3339))
	var audit map[string]json.RawMessage
	if err := json.Unmarshal(events[0]["details"], &audit); err != nil {
		t.Fatal(err)
	}
	check(audit["expiresAt"], utc.Add(5*time.Minute).Format(time.RFC3339))
	if string(audit["other"]) != "9007199254740993" {
		t.Fatal("unrelated audit field changed", string(audit["other"]))
	}
	var stored string
	if err := f.s.DB.QueryRow("SELECT details FROM events").Scan(&stored); err != nil || stored != details {
		t.Fatal("stored audit changed", stored, err)
	}

	id := f.create(t)
	status, data := f.request(t, f.owner, "DELETE", "/api/v1/admin/rooms/"+id, map[string]bool{"confirm": true})
	if status != 202 {
		t.Fatal(status, string(data))
	}
	var operation map[string]json.RawMessage
	if err := json.Unmarshal(data, &operation); err != nil {
		t.Fatal(err)
	}
	check(operation["deadlineAt"], utc.Add(f.s.Warning).Format(time.RFC3339Nano))
}

func TestAuditDatesKeepPermanentAndUnrelatedDetails(t *testing.T) {
	for _, raw := range []string{`{"id":"ban","expiresAt":null}`, `{"id":"ban"}`} {
		actual, err := eventDetails("sanction", raw)
		if err != nil {
			t.Fatal(err)
		}
		var want, got any
		if err := json.Unmarshal([]byte(raw), &want); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(actual, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatal(string(actual), raw)
		}
	}
	const raw = `{"previous":"Old name","name":"New name"}`
	actual, err := eventDetails("room_rename", raw)
	if err != nil || string(actual) != raw {
		t.Fatal(string(actual), err)
	}
}
