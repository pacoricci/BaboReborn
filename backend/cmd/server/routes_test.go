package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRoutesServeDiagnosticsOnlyWhenEnabled(t *testing.T) {
	rooms := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	latency := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusAccepted) })
	for _, c := range []struct {
		path        string
		diagnostics bool
		status      int
	}{
		{"/diagnostics", false, http.StatusNotFound},
		{"/diagnostics", true, http.StatusTeapot},
		{"/ws", false, http.StatusTeapot},
		{"/health", false, http.StatusTeapot},
		{"/metrics", false, http.StatusTeapot},
		{"/latency", false, http.StatusAccepted},
		{"/unknown", true, http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		routes(rooms, latency, c.diagnostics).ServeHTTP(w, httptest.NewRequest(http.MethodGet, c.path, nil))
		if w.Code != c.status {
			t.Errorf("%s with diagnostics=%v: status %d, want %d", c.path, c.diagnostics, w.Code, c.status)
		}
	}
}
