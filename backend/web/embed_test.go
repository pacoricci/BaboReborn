package web

import (
	"bytes"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReleaseHandlerServesOnlyProductSurfaces(t *testing.T) {
	handler := Handler()
	for _, path := range []string{"/credits.html", "/privacy.html", "/terms.html", "/licenses/BaboViolent2.txt", "/icons/Tabler-LICENSE.txt", "/play.html", "/manage.html", "/match.html", "/editor.html", "/favicon.svg"} {
		status := statusFollowingRedirects(t, handler, path)
		if status != http.StatusOK {
			t.Errorf("product path %s returned %d", path, status)
		}
	}

	for _, path := range []string{
		"/practice.html",
		"/online.html",
		"/frontend/src/apps/practice/main.ts",
		"/devtools/browser/",
		"/devtools/browser/index.html",
		"/devtools/browser/visual-kit.html",
	} {
		status := statusFollowingRedirects(t, handler, path)
		if status != http.StatusNotFound {
			t.Errorf("development path %s returned %d", path, status)
		}
	}
}

func statusFollowingRedirects(t *testing.T, handler http.Handler, path string) int {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	for range 5 {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code < 300 || response.Code >= 400 {
			return response.Code
		}
		next, err := request.URL.Parse(response.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		request = httptest.NewRequest(http.MethodGet, next.RequestURI(), nil)
	}
	t.Fatal("too many redirects", path)
	return 0
}

func TestEmbeddedReleaseContainsNoDevelopmentChunksOrHooks(t *testing.T) {
	markers := [][]byte{
		[]byte("/practice.html"),
		[]byte("/devtools/browser/"),
		[]byte("baboreborn-local-range-"),
		[]byte("__matchDiagnostics"),
		[]byte("Export internal diagnostics"),
	}
	err := fs.WalkDir(assets, "dist", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.Contains(path, "/practice") || strings.Contains(path, "/devtools/browser/") {
			t.Errorf("development artifact embedded: %s", path)
		}
		if entry.IsDir() || (!strings.HasSuffix(path, ".html") && !strings.HasSuffix(path, ".js")) {
			return nil
		}
		contents, err := assets.ReadFile(path)
		if err != nil {
			return err
		}
		for _, marker := range markers {
			if bytes.Contains(contents, marker) {
				t.Errorf("development marker %q embedded in %s", marker, path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
