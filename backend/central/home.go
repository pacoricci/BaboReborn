package central

import (
	"database/sql"
	"errors"
	"html/template"
	"net/http"

	"baboreborn/backend/identity"
	"baboreborn/backend/web"
)

var homeHTML = web.PortalSource("home.html")

var accountJS = web.PortalSource("account.js")

func serveAccountScript(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	_, _ = w.Write([]byte(accountJS)) //nolint:errcheck // The client may have disconnected.
}

var homeTemplate = template.Must(template.New("home").Parse(homeHTML + web.PortalSource("account.html") + web.PortalSource("management.html")))

func (s *Service) home(w http.ResponseWriter, r *http.Request) {
	data := struct {
		Account                                              string
		AccountPage, ManagementPage, Expired, LoginAvailable bool
		SignedOut, Revoked, Deleted, DeleteBlocked           bool
	}{AccountPage: r.URL.Path == "/account", ManagementPage: r.URL.Path == "/manage/servers", LoginAvailable: s.Verifier != nil,
		SignedOut: r.URL.Query().Get("notice") == "signed_out", Revoked: r.URL.Query().Get("notice") == "sessions_revoked",
		Deleted: r.URL.Query().Get("notice") == "account_deleted", DeleteBlocked: r.URL.Query().Get("notice") == "account_has_servers"}
	if current, err := s.session(r); err == nil {
		data.Account = current.Account
	} else if errors.Is(err, sql.ErrNoRows) {
		data.Expired = true
	} else if !errors.Is(err, http.ErrNoCookie) {
		identity.Error(w, http.StatusServiceUnavailable, "account_unavailable")
		return
	}
	// Native POST forms need a non-opaque Origin. Keep referrers local while
	// authentication callbacks retain the default no-referrer policy.
	w.Header().Set("Referrer-Policy", "same-origin")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = homeTemplate.Execute(w, data) //nolint:errcheck // A closed client cannot receive an error page.
}

func serveManagementStyle(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	_, _ = w.Write([]byte(web.PortalSource("management.css"))) //nolint:errcheck // The browser may disconnect.
}

func serveTopbarStyle(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	_, _ = w.Write([]byte(web.PortalSource("topbar.css"))) //nolint:errcheck // The browser may disconnect.
}

func (s *Service) productPage(asset string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Files == nil {
			http.NotFound(w, r)
			return
		}
		request := r.Clone(r.Context())
		request.URL.Path = "/" + asset
		s.Files.ServeHTTP(w, request)
	}
}

func serveProductStyle(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	_, _ = w.Write([]byte(web.PortalSource("product.css"))) //nolint:errcheck // The browser may disconnect.
}
