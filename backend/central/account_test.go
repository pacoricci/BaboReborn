package central

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"baboreborn/backend/identity"
)

func deleteAccountForm(s *Service, cookie, account, confirm, origin string) *httptest.ResponseRecorder {
	form := url.Values{"account": {account}, "confirm": {confirm}}
	r := httptest.NewRequest("POST", "/auth/delete-account", strings.NewReader(form.Encode()))
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Origin", origin)
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: "central_session", Value: cookie})
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func TestDeleteAccountRequiresSessionOriginAndMatchingConfirmation(t *testing.T) {
	s := testService(t)
	cookie, account := accountCookie(t, s, "delete-guard")
	for _, tc := range []struct {
		name, cookie, account, confirm, origin string
		status                                 int
	}{
		{"guest", "", account, "delete", s.Origin, 401},
		{"foreign origin", cookie, account, "delete", "https://foreign.test", 403},
		{"opaque origin", cookie, account, "delete", "null", 403},
		{"missing origin", cookie, account, "delete", "", 403},
		{"missing confirmation", cookie, account, "", s.Origin, 400},
		{"stale page", cookie, identity.ID(), "delete", s.Origin, 400},
		{"oversized form", cookie, strings.Repeat("a", accountFormMaxBytes), "delete", s.Origin, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := deleteAccountForm(s, tc.cookie, tc.account, tc.confirm, tc.origin)
			if response.Code != tc.status {
				t.Fatalf("got %d: %s", response.Code, response.Body.String())
			}
		})
	}
	response := httptest.NewRecorder()
	s.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/auth/delete-account", nil))
	if response.Code == http.StatusOK || response.Code == http.StatusSeeOther {
		t.Fatal("GET must not delete accounts")
	}
	if status, _ := portalRequest(t, s, cookie, "GET", "/api/v1/account", nil); status != 200 {
		t.Fatal("guarded request changed session")
	}
	var count int
	if err := s.DB.QueryRow("SELECT count(*) FROM accounts WHERE id=$1", account).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
}

func TestDeleteAccountErasesCentralDataAndAllSessions(t *testing.T) {
	s := testService(t)
	cookie, account := accountCookie(t, s, "erase-user")
	secondCookie, _ := accountCookie(t, s, "erase-user")
	otherCookie, other := accountCookie(t, s, "other-user")
	removed, _ := management(t, s, cookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Removed", "region": "EU", "origin": "https://removed.test"})
	management(t, s, cookie, "DELETE", "/api/v1/manage/servers/"+removed.ID, nil)
	preserved, _ := management(t, s, otherCookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Other", "region": "EU", "origin": "https://other.test"})
	// A former owner's audit record on a server now owned by somebody else.
	if _, err := s.DB.Exec("INSERT INTO registry_events(server_id,actor,action,created_at,revision) VALUES($1,$2,'transfer',$3,1)", preserved.ID, account, s.now()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("INSERT INTO external_identities VALUES('other-issuer','linked-subject',$1)", account); err != nil {
		t.Fatal(err)
	}
	response := deleteAccountForm(s, cookie, account, "delete", s.Origin)
	if response.Code != 303 || response.Header().Get("Location") != "/account?notice=account_deleted" {
		t.Fatal(response.Code, response.Body.String())
	}
	if cookies := response.Result().Cookies(); len(cookies) != 1 || cookies[0].Value != "signed-out" || !cookies[0].HttpOnly {
		t.Fatal("missing signed-out cookie")
	}
	for _, query := range []string{
		"SELECT count(*) FROM accounts WHERE id=$1",
		"SELECT count(*) FROM external_identities WHERE account_id=$1",
		"SELECT count(*) FROM sessions WHERE account_id=$1",
		"SELECT count(*) FROM registered_servers WHERE owner_id=$1 OR transfer_to=$1",
		"SELECT count(*) FROM registry_events WHERE actor=$1",
	} {
		var count int
		if err := s.DB.QueryRow(query, account).Scan(&count); err != nil || count != 0 {
			t.Fatal(query, count, err)
		}
	}
	var count int
	if err := s.DB.QueryRow("SELECT count(*) FROM registry_events WHERE server_id=$1 AND actor='deleted-account'", preserved.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("other server history lost", count, err)
	}
	for _, credential := range []string{cookie, secondCookie} {
		status, _ := portalRequest(t, s, credential, "POST", "/identity/v1/access", map[string]string{"serverId": preserved.ID})
		if status != 401 {
			t.Fatal("deleted session can obtain access proof", status)
		}
	}
	if status, _ := portalRequest(t, s, "", "GET", "/identity/v1/accounts/"+account, nil); status != 404 {
		t.Fatal("deleted account still exists", status)
	}
	if status, body := portalRequest(t, s, otherCookie, "GET", "/api/v1/account", nil); status != 200 || !strings.Contains(string(body), other) {
		t.Fatal("other account affected", status, string(body))
	}
	_, recreated := accountCookie(t, s, "erase-user")
	if recreated == account {
		t.Fatal("sign-in restored deleted account")
	}
}

func TestDeleteAccountProtectsServerOwnershipAndTransfers(t *testing.T) {
	for _, kind := range []string{"pending-owner", "active-owner", "invitation", "accepted-transfer"} {
		t.Run(kind, func(t *testing.T) {
			s := testService(t)
			cookie, account := accountCookie(t, s, "requester")
			ownerCookie := cookie
			if kind == "invitation" || kind == "accepted-transfer" {
				ownerCookie, _ = accountCookie(t, s, "owner")
			}
			server, _ := management(t, s, ownerCookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Protected", "region": "EU", "origin": "https://protected.test"})
			if kind == "active-owner" {
				if _, err := s.DB.Exec("UPDATE registered_servers SET status='active' WHERE id=$1", server.ID); err != nil {
					t.Fatal(err)
				}
			}
			if kind == "invitation" || kind == "accepted-transfer" {
				if _, err := s.DB.Exec("UPDATE registered_servers SET transfer_to=$2,transfer_accepted=$3 WHERE id=$1", server.ID, account, kind == "accepted-transfer"); err != nil {
					t.Fatal(err)
				}
			}
			response := deleteAccountForm(s, cookie, account, "delete", s.Origin)
			if response.Code != 303 || response.Header().Get("Location") != "/account?notice=account_has_servers" {
				t.Fatal(response.Code, response.Body.String())
			}
			if status, body := portalRequest(t, s, cookie, "GET", "/api/v1/account", nil); status != 200 || !strings.Contains(string(body), account) {
				t.Fatal("blocked deletion ended session", status, string(body))
			}
			if _, err := s.readServer(context.Background(), s.DB, server.ID, false); err != nil {
				t.Fatal("blocked deletion removed server", err)
			}
		})
	}
}

func TestDeleteAccountRollsBackOnStorageFailure(t *testing.T) {
	s := testService(t)
	cookie, account := accountCookie(t, s, "rollback-user")
	// A late failure must not leave the account detached from its login or sessions.
	if _, err := s.DB.Exec(`CREATE FUNCTION reject_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'test storage failure'; END; $$;
		CREATE TRIGGER reject_account_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION reject_account_delete()`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := s.DB.Exec("DROP TRIGGER reject_account_delete ON accounts; DROP FUNCTION reject_account_delete()"); err != nil {
			t.Error(err)
		}
	}()
	response := deleteAccountForm(s, cookie, account, "delete", s.Origin)
	if response.Code != 503 || len(response.Result().Cookies()) != 0 {
		t.Fatal("failed deletion reported success", response.Code)
	}
	if status, body := portalRequest(t, s, cookie, "GET", "/api/v1/account", nil); status != 200 || !strings.Contains(string(body), account) {
		t.Fatal("rollback lost session", status, string(body))
	}
	_, again := accountCookie(t, s, "rollback-user")
	if again != account {
		t.Fatal("rollback lost external identity")
	}
}

func TestDeleteAccountRechecksSessionInsideTransaction(t *testing.T) {
	s := testService(t)
	cookie, account := accountCookie(t, s, "revoked-user")
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: "central_session", Value: cookie})
	current, err := s.session(r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec("UPDATE sessions SET revoked_at=$1 WHERE id=$2", s.now(), current.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.eraseAccount(context.Background(), current); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("revoked session could delete account", err)
	}
	if status, _ := portalRequest(t, s, "", "GET", "/identity/v1/accounts/"+account, nil); status != 200 {
		t.Fatal("account deleted", status)
	}
}
