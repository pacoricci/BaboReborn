package registry

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
)

func TestTLSVerificationRequiresSignedHTTPSAndWebSocketChallenges(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	expected := Compatibility{API: 1, Identity: 1, Protocol: 1, Profile: "rules", ContentSchema: 1}
	for _, failure := range []string{"", "redirect", "signature", "nonce", "contract", "size", "websocket", "ws_release", "ws_contract"} {
		t.Run(failure, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if failure == "redirect" {
					http.Redirect(w, r, "https://127.0.0.1/", http.StatusFound)
					return
				}
				if failure == "size" {
					if _, err := w.Write([]byte(strings.Repeat("x", 16385))); err != nil {
						return
					}
					return
				} //nolint:errcheck // Probe will intentionally refuse this body.
				probe := Probe{Release: "1.0.0", Nonce: r.URL.Query().Get("nonce"), Compatibility: expected}
				if failure == "nonce" {
					probe.Nonce = "replayed"
				}
				if failure == "contract" {
					probe.Compatibility.Protocol++
				}
				if r.URL.Path == "/ws" {
					if failure == "ws_release" {
						probe.Release = "2.0.0"
					}
					if failure == "ws_contract" {
						probe.Compatibility.API++
					}
				}
				packet, err := Sign(key, probe)
				if err != nil {
					t.Error(err)
					return
				}
				if failure == "signature" {
					packet.Signature = "invalid"
				}
				raw, err := json.Marshal(packet)
				if err != nil {
					t.Error(err)
					return
				}
				if r.URL.Path == "/ws" {
					if failure == "websocket" {
						http.NotFound(w, r)
						return
					}
					if r.Header.Get("Origin") != "https://portal.example" {
						t.Error("portal origin absent")
						return
					}
					conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
					if err != nil {
						return
					}
					defer conn.CloseNow()                                   //nolint:errcheck // Test cleanup.
					_ = conn.Write(r.Context(), websocket.MessageText, raw) //nolint:errcheck // A failed probe may close first.
				} else {
					if _, err := w.Write(raw); err != nil {
						return
					}
				} //nolint:errcheck // Test response cleanup.
			}))
			defer server.Close()
			verifier := NewVerifier("https://portal.example", true, expected)
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			verifier.TLS = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
			observed, err := verifier.Check(context.Background(), server.URL, Public(key))
			if failure == "" || failure == "contract" {
				if observed == nil || observed.Release != "1.0.0" {
					t.Fatal("signed release missing", observed)
				}
			} else if observed != nil {
				t.Fatal("unverified release escaped failed probe", observed)
			}
			if failure == "" && err != nil {
				t.Fatal(err)
			}
			if failure != "" && err == nil {
				t.Fatal("invalid external probe accepted", failure)
			}
		})
	}
	public := NewVerifier("https://portal.example", false, expected)
	if _, err := public.Check(context.Background(), "https://127.0.0.1", Public(key)); err == nil || err.Error() != "non_public_origin" {
		t.Fatal("public verifier accepted loopback", err)
	}
}

func TestTLSVerificationTriesValidatedAddresses(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	expected := Compatibility{API: 1, Identity: 1, Protocol: 1, Profile: "rules", ContentSchema: 1}
	var httpsCalls, wsCalls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		packet, err := Sign(key, Probe{Nonce: r.URL.Query().Get("nonce"), Compatibility: expected})
		if err != nil {
			t.Error(err)
			return
		}
		body, err := json.Marshal(packet)
		if err != nil {
			t.Error(err)
			return
		}
		if r.URL.Path == "/ws" {
			wsCalls.Add(1)
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if err != nil {
				t.Error(err)
				return
			}
			defer conn.CloseNow()                                    //nolint:errcheck // Test cleanup.
			_ = conn.Write(r.Context(), websocket.MessageText, body) //nolint:errcheck // Probe may close first.
			return
		}
		httpsCalls.Add(1)
		if _, err := w.Write(body); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	target, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	good := netip.MustParseAddr(target.Hostname())
	bad := netip.MustParseAddr("127.0.0.2")
	verifier := NewVerifier("https://portal.example", true, expected)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	verifier.TLS = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	addresses := []netip.Addr{bad, good}
	verifier.lookupNetIP = func(context.Context, string, string) ([]netip.Addr, error) { return addresses, nil }
	if _, err := verifier.Check(context.Background(), server.URL, Public(key)); err != nil {
		t.Fatal(err)
	}
	if httpsCalls.Load() != 1 || wsCalls.Load() != 1 {
		t.Fatal("healthy address did not complete both probes", httpsCalls.Load(), wsCalls.Load())
	}

	addresses = []netip.Addr{bad, netip.MustParseAddr("127.0.0.3")}
	if _, err := verifier.Check(context.Background(), server.URL, Public(key)); err == nil || err.Error() != "https_unreachable" {
		t.Fatal("unreachable addresses were accepted", err)
	}
	addresses = []netip.Addr{good, netip.MustParseAddr("192.0.2.1")}
	if _, err := verifier.Check(context.Background(), server.URL, Public(key)); err == nil || err.Error() != "non_public_origin" {
		t.Fatal("mixed public and non-public DNS results were accepted", err)
	}
	if httpsCalls.Load() != 1 || wsCalls.Load() != 1 {
		t.Fatal("invalid address list was probed", httpsCalls.Load(), wsCalls.Load())
	}
}
