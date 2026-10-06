package central

import (
	"encoding/xml"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"baboreborn/backend/web"
)

func TestLandingCanonicalAndRedirect(t *testing.T) {
	handler := (&Service{Files: web.Handler()}).Handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "http://untrusted.example/?campaign=test", nil))
	for _, marker := range []string{`rel="canonical" href="https://baboreborn.com/"`, `property="og:url" content="https://baboreborn.com/"`, `https://baboreborn.com/assets/home/arena-battle.jpg`} {
		if !strings.Contains(response.Body.String(), marker) {
			t.Errorf("missing metadata: %s", marker)
		}
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/landing.html?campaign=test", nil))
	if response.Code != http.StatusMovedPermanently || response.Header().Get("Location") != "/" {
		t.Fatalf("redirect: %d %q", response.Code, response.Header().Get("Location"))
	}
}

func TestPublicSitemap(t *testing.T) {
	handler := (&Service{Files: web.Handler()}).Handler()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/sitemap.xml", nil))
	var sitemap struct {
		URLs []struct {
			Location string `xml:"loc"`
		} `xml:"url"`
	}
	if response.Code != http.StatusOK {
		t.Fatalf("sitemap status: %d", response.Code)
	}
	if err := xml.Unmarshal(response.Body.Bytes(), &sitemap); err != nil {
		t.Fatal(err)
	}
	if len(sitemap.URLs) != 4 {
		t.Fatalf("unexpected sitemap entries: %d", len(sitemap.URLs))
	}
	for _, entry := range sitemap.URLs {
		if !strings.HasPrefix(entry.Location, "https://baboreborn.com/") {
			t.Fatalf("unexpected origin: %s", entry.Location)
		}
		page := httptest.NewRecorder()
		handler.ServeHTTP(page, httptest.NewRequest("GET", entry.Location, nil))
		if page.Code != http.StatusOK {
			t.Errorf("%s: status %d", entry.Location, page.Code)
		}
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest("GET", "/robots.txt", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Sitemap: https://baboreborn.com/sitemap.xml") {
		t.Fatal("robots.txt must advertise the sitemap")
	}
}
