package central

import (
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestAccountScriptAndPagePolicy(t *testing.T) {
	s := testService(t)
	for _, path := range []string{"/account", "/manage/servers", "/assets/account.js", "/assets/topbar.css", "/assets/product.css"} {
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 200 || !strings.Contains(response.Header().Get("Content-Security-Policy"), "script-src 'self'") {
			t.Fatalf("%s: %d", path, response.Code)
		}
	}
	for _, test := range []struct {
		path, current string
	}{
		{"/account", `<a href="/account" aria-current="page"\s*>Account</a>`},
		{"/manage/servers", `<a href="/manage/servers" aria-current="page"\s*>Servers</a>`},
	} {
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, httptest.NewRequest("GET", test.path, nil))
		body := response.Body.String()
		// Match HTML semantics: insignificant whitespace and class ordering may vary.
		for _, pattern := range []string{test.current, `class="(?:[^"]*\s)?product-topbar(?:\s[^"]*)?"`} {
			if !regexp.MustCompile(pattern).MatchString(body) {
				t.Fatalf("%s does not use the shared navigation: missing %s", test.path, pattern)
			}
		}
		for _, fragment := range []string{`href="/assets/topbar.css"`, `href="/assets/product.css"`, `class="product-nav"`} {
			if !strings.Contains(body, fragment) {
				t.Fatalf("%s does not use the shared topbar: missing %s", test.path, fragment)
			}
		}
	}
	for _, path := range []string{"/unknown-page", "/api/v1/unknown", "/assets/unknown.js"} {
		response := httptest.NewRecorder()
		s.Handler().ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 404 {
			t.Fatalf("unknown route %s: %d", path, response.Code)
		}
	}
}
