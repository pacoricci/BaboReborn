package central

import (
	"net/http/httptest"
	"strings"
	"testing"

	"baboreborn/backend/web"
)

func TestLoginReturnRoomCatalog(t *testing.T) {
	for _, target := range []string{"/rooms", "/rooms?notice=authentication_expired", "/"} {
		request := httptest.NewRequest("GET", "/auth/login", nil)
		query := request.URL.Query()
		query.Set("return", target)
		request.URL.RawQuery = query.Encode()
		if got := loginReturn(request); got != target {
			t.Errorf("loginReturn(%q) = %q", target, got)
		}
	}
}

func TestPublicHomeAndRoomRoutes(t *testing.T) {
	service := &Service{Files: web.Handler()}
	handler := service.Handler()
	for _, test := range []struct{ path, content string }{
		{"/", "SMALL BODY."},
		{"/rooms", "play-root"},
		{"/character", "play-root"},
		{"/rooms/" + strings.Repeat("a", 32) + "." + strings.Repeat("b", 32), "match-screen"},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest("GET", test.path, nil))
		if response.Code != 200 || !strings.Contains(response.Body.String(), test.content) {
			t.Errorf("%s: status %d, missing %q", test.path, response.Code, test.content)
		}
	}
}
