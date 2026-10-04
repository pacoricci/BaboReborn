package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/server/match"
)

func TestLiveDeliveryTraceCorrelatesSocketAndOwner(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := New(match.MustNew(testcontent.Map("kiln")), 2, nil)
	go s.Run(ctx)
	handler := s.Handler(ctx)
	r := httptest.NewRequest("POST", "/diagnostics", nil)
	r.RemoteAddr = "127.0.0.1:1000"
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	httpServer := httptest.NewServer(handler)
	defer httpServer.Close()
	c, _, err := dialAuthenticated(ctx, "ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws?"+admissionQuery(compatibility.GameProfile()), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow() //nolint:errcheck // Test socket cleanup.
	var welcome struct{ Type string }
	if err := readMessage(ctx, c, &welcome); err != nil {
		t.Fatal(err)
	}
	if err := writeMessage(ctx, c, Message{Type: "join", Version: gameconfig.ProtocolVersion}); err != nil {
		t.Fatal(err)
	}
	seq := 0
	for i := 0; i < 6; i++ {
		var state receivedSnapshot
		if err := readMessage(ctx, c, &state); err != nil {
			t.Fatal(err)
		}
		if state.Type == "snapshot" && len(state.Players) > 0 && state.Players[0].Status == "alive" {
			seq++
			if err := writeMessage(ctx, c, Message{Type: "input", Version: gameconfig.ProtocolVersion, Inputs: []match.Command{{Seq: seq, Life: state.Players[0].Life, Input: core.Input{X: 1, Aim: core.Vec2{X: 12, Y: 4}}}}}); err != nil {
				t.Fatal(err)
			}
		}
	}
	r.Method = "GET"
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	var trace struct{ Samples []traceSample }
	if err := json.Unmarshal(w.Body.Bytes(), &trace); err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	first := map[string]float64{}
	for _, sample := range trace.Samples {
		kinds[sample.Kind] = true
		if sample.Sequence == 1 {
			first[sample.Kind] = sample.AtMS
		}
		if sample.WaitMS < 0 || sample.DurationMS < 0 {
			t.Fatal("negative phase duration")
		}
	}
	for _, kind := range []string{"selected_installation", "write_start", "write_end", "written_processed", "receipt_processed", "selected_state", "input_processed", "published", "input_empty"} {
		if !kinds[kind] {
			t.Fatalf("missing phase %s: %s", kind, w.Body.String())
		}
	}
	if first["selected_installation"] > first["write_start"] || first["write_start"] > first["write_end"] || first["write_end"] > first["written_processed"] {
		t.Fatal("socket and owner clocks disagree")
	}
}

func TestDeliveryTraceLocalAccessAndRetention(t *testing.T) {
	s := &Server{}
	s.trace.origin = time.Now().Add(-time.Second)
	handler := s.Handler(context.Background())
	request := func(method, remote, origin string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/diagnostics?connection=one", nil)
		r.RemoteAddr = remote
		r.Header.Set("Origin", origin)
		r.Header.Set("X-Forwarded-For", "127.0.0.1")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, remote := range []string{"192.0.2.1:1000", "172.18.0.1:1000", "invalid"} {
		if w := request("POST", remote, ""); w.Code != http.StatusForbidden {
			t.Fatal("remote trace access allowed")
		}
	}
	if w := request("POST", "127.0.0.1:1000", "https://example.com"); w.Code != http.StatusForbidden {
		t.Fatal("browser trace access allowed")
	}
	if w := request("POST", "127.0.0.1:1000", ""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if w := request("POST", "127.0.0.1:1000", ""); w.Code != http.StatusConflict {
		t.Fatal("active capture overwritten")
	}
	at := s.trace.started.Add(time.Millisecond)
	s.trace.record("other", at, traceSample{Kind: "ignored"})
	for i := 0; i < traceCapacity+2; i++ {
		s.trace.record("one", at.Add(time.Duration(i)*time.Microsecond), traceSample{Kind: "selected_state", Sequence: i + 1})
	}
	s.trace.record("one", s.trace.until, traceSample{Kind: "too_late"})
	w := request("GET", "[::1]:1000", "")
	var got struct {
		Connection        string
		Collecting        bool
		CapacityEvictions int
		Samples           []traceSample
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Connection != "one" || got.Collecting || got.CapacityEvictions != 2 || len(got.Samples) != traceCapacity || got.Samples[0].Sequence != 3 {
		t.Fatalf("invalid bounded trace: %s", w.Body.Bytes()[:100])
	}
	if s.trace.enabled.Load() {
		t.Fatal("capture did not expire")
	}
}

type blockedTraceResponse struct {
	header           http.Header
	entered, release chan struct{}
}

func (w *blockedTraceResponse) Header() http.Header { return w.header }
func (w *blockedTraceResponse) WriteHeader(int)     {}
func (w *blockedTraceResponse) Write(p []byte) (int, error) {
	close(w.entered)
	<-w.release
	return len(p), nil
}

func TestTraceExportDoesNotBlockRecording(t *testing.T) {
	s := &Server{}
	r := httptest.NewRequest("POST", "/diagnostics", nil)
	r.RemoteAddr = "127.0.0.1:1000"
	s.diagnostics(httptest.NewRecorder(), r)
	s.trace.record("one", time.Now(), traceSample{Kind: "start"})
	w := &blockedTraceResponse{header: make(http.Header), entered: make(chan struct{}), release: make(chan struct{})}
	r.Method = "GET"
	done := make(chan struct{})
	go func() { s.diagnostics(w, r); close(done) }()
	<-w.entered
	recorded := make(chan struct{})
	go func() { s.trace.record("one", time.Now(), traceSample{Kind: "while_exporting"}); close(recorded) }()
	select {
	case <-recorded:
	case <-time.After(time.Second):
		close(w.release)
		t.Fatal("slow exporter blocked simulation trace")
	}
	close(w.release)
	<-done
}

func BenchmarkDeliveryTrace(b *testing.B) {
	for _, enabled := range []bool{false, true} {
		name := "disabled"
		if enabled {
			name = "enabled"
		}
		b.Run(name, func(b *testing.B) {
			now := time.Now()
			trace := deliveryTrace{origin: now, started: now, until: now.Add(traceDuration), connection: "one", samples: make([]traceSample, 0, traceCapacity)}
			trace.enabled.Store(enabled)
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				trace.record("one", now, traceSample{Kind: "selected_state", Sequence: 1})
			}
		})
	}
}
