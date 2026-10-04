package registration

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"baboreborn/backend/registry"
)

func testClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{Central: server.URL, HTTP: server.Client(), key: key}
	c.current = registry.Descriptor{ID: "server", PublicKey: registry.Public(key), Revision: 1}
	c.Verify = func(_ string, _ string, out any) error {
		*out.(*registry.Descriptor) = c.current
		return nil
	}
	c.Apply = func(context.Context, registry.Descriptor, ed25519.PrivateKey) error { return nil }
	return c
}

func respond(t *testing.T, w http.ResponseWriter, status int, value any) {
	t.Helper()
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Error(err)
	}
}

func TestOperationClassification(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		retry      bool
	}{
		{"transient", `{"error":"verification_busy","recoverable":true}`, 409, true},
		{"terminal", `{"error":"invalid_pairing_code","recoverable":false}`, 409, false},
		{"proxy", `bad gateway`, 502, true},
		{"rate limit", `{"error":"limited"}`, 429, true},
		{"forbidden", `{"error":"forbidden"}`, 403, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				if _, err := w.Write([]byte(tc.body)); err != nil {
					t.Error(err)
				}
			})
			err := c.post(context.Background(), "/", struct{}{}, nil)
			var problem *OperationError
			if !errors.As(err, &problem) || problem.Recoverable != tc.retry {
				t.Fatalf("unexpected error: %#v", err)
			}
		})
	}
}

func TestRunBackoffAndSuccessReset(t *testing.T) {
	nonces := 0
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/registry/v1/nonce" {
			nonces++
			respond(t, w, 200, map[string]string{"nonce": fmt.Sprint(nonces)})
			return
		}
		// Eight failures reach the cap; heartbeat and ack then succeed.
		if nonces == 9 || nonces == 10 {
			respond(t, w, 200, map[string]string{"response": "signed"})
		} else {
			respond(t, w, 409, map[string]any{"error": "verification_busy", "recoverable": true})
		}
	})
	originalKey := registry.Public(c.key)
	var delays []time.Duration
	randomValues := []float64{0, .5, .999, 0, .5, .999, 0, .5, 0}
	randomCalls := 0
	c.run(context.Background(), func(_ context.Context, d time.Duration) bool {
		delays = append(delays, d)
		return len(delays) < 10
	}, func() float64 { v := randomValues[randomCalls]; randomCalls++; return v })
	caps := []time.Duration{5, 10, 20, 40, 80, 120, 120, 120, 5}
	for i, capSeconds := range caps {
		index := i
		if i == 8 {
			index = 9
		}
		capDelay := capSeconds * time.Second
		want := capDelay/2 + time.Duration(randomValues[i]*float64(capDelay/2))
		if delays[index] != want {
			t.Fatalf("delay %d = %s, want %s", index, delays[index], want)
		}
	}
	if delays[8] != registry.Heartbeat {
		t.Fatalf("success delay: %s", delays[8])
	}
	if nonces != 11 || registry.Public(c.key) != originalKey {
		t.Fatal("retry must acquire new nonces without changing identity")
	}
}

func TestRunTerminalAndRevocation(t *testing.T) {
	for _, code := range []string{"invalid_pairing_code", "installation_revoked"} {
		t.Run(code, func(t *testing.T) {
			calls, applied := 0, false
			c := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
				calls++
				respond(t, w, 409, map[string]any{"error": code, "recoverable": false})
			})
			c.Apply = func(_ context.Context, d registry.Descriptor, _ ed25519.PrivateKey) error {
				applied = d.Status == "removed"
				return nil
			}
			c.run(context.Background(), func(context.Context, time.Duration) bool { t.Fatal("terminal failure waited for retry"); return false }, func() float64 { t.Fatal("terminal failure requested jitter"); return 0 })
			if calls != 1 || applied != (code == "installation_revoked") {
				t.Fatalf("calls=%d applied=%v", calls, applied)
			}
			if code == "installation_revoked" {
				if c.Snapshot().Status != "removed" {
					t.Fatal("revocation not applied")
				}
				c.Run(context.Background())
				if calls != 1 {
					t.Fatal("persisted removal must not contact central again")
				}
			}
		})
	}
}

func TestRunCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	c := testClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls++
		respond(t, w, 503, map[string]any{"error": "registry_unavailable", "recoverable": true})
	})
	c.run(ctx, func(ctx context.Context, _ time.Duration) bool {
		cancel()
		return waitRetry(ctx, time.Hour)
	}, func() float64 { return .5 })
	if calls != 1 {
		t.Fatalf("calls = %d", calls)
	}
	c.Run(ctx)
	if calls != 1 {
		t.Fatal("cancelled run made a request")
	}
}

func TestRunWaitsForPublisherAfterTerminalRegistryError(t *testing.T) {
	entered := make(chan struct{})
	exited := make(chan struct{})
	requestDone := make(chan struct{})
	c := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/registry/v1/nonce":
			respond(t, w, 200, map[string]string{"nonce": "challenge"})
		case "/registry/v1/request":
			select {
			case <-entered:
				close(requestDone)
				respond(t, w, 409, map[string]any{"error": "invalid_pairing_code", "recoverable": false})
			case <-r.Context().Done():
			}
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
		}
	})
	c.current.Status = "active"
	c.Publication = func(ctx context.Context) (registry.Publication, error) {
		close(entered)
		<-ctx.Done()
		close(exited)
		return registry.Publication{}, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c.Run(ctx)
	select {
	case <-requestDone:
	default:
		t.Fatal("registry did not stop on the terminal response")
	}
	select {
	case <-exited:
	default:
		t.Fatal("Run returned while its publisher was still active")
	}
}
