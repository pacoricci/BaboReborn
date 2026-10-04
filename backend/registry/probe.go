package registry

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/identity"
)

// PublicAddress excludes special-use destinations, including IPv4-mapped IPv6.
func PublicAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return false
	}
	if addr.Is6() && !netip.MustParsePrefix("2000::/3").Contains(addr) {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/23", "3fff::/20", "2002::/16", "64:ff9b::/96", "64:ff9b:1::/48"} {
		if netip.MustParsePrefix(block).Contains(addr) {
			return false
		}
	}
	return true
}

type Verifier struct {
	Origin      string
	Development bool
	Expected    Compatibility
	TLS         *tls.Config // Tests use an isolated CA; production keeps system verification.
	slots       chan struct{}
	lookupNetIP func(context.Context, string, string) ([]netip.Addr, error)
}

func NewVerifier(origin string, development bool, expected Compatibility) *Verifier {
	return &Verifier{Origin: origin, Development: development, Expected: expected, slots: make(chan struct{}, 8)}
}

// Check returns a signed observation on success or an HTTPS contract mismatch.
// Other failures never produce a compatibility verdict.
func (v *Verifier) Check(ctx context.Context, origin, key string) (*Probe, error) {
	if identity.Origin(origin, v.Development) != nil {
		return nil, fmt.Errorf("invalid_origin")
	}
	select {
	case v.slots <- struct{}{}:
		defer func() { <-v.slots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, fmt.Errorf("verification_busy")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	target, parseErr := url.Parse(origin)
	if parseErr != nil {
		return nil, parseErr
	}
	lookupNetIP := v.lookupNetIP
	if lookupNetIP == nil {
		lookupNetIP = net.DefaultResolver.LookupNetIP
	}
	addresses, err := lookupNetIP(ctx, "ip", target.Hostname())
	if err != nil || len(addresses) == 0 {
		return nil, fmt.Errorf("dns_unavailable")
	}
	for _, addr := range addresses {
		if !PublicAddress(addr) && (!v.Development || !addr.IsLoopback()) {
			return nil, fmt.Errorf("non_public_origin")
		}
	}
	port := target.Port()
	if port == "" {
		port = "443"
		if target.Scheme == "http" {
			port = "80"
		}
	}
	var probeErr error
	var observed *Probe
	for _, addr := range addresses {
		observed, probeErr = v.checkAddress(ctx, origin, key, port, addr)
		if probeErr == nil {
			return observed, probeErr
		}
		if ctx.Err() != nil {
			return observed, probeErr
		}
	}
	return observed, probeErr
}

func (v *Verifier) checkAddress(ctx context.Context, origin, key, port string, addr netip.Addr) (*Probe, error) {
	// Pin each pair of probes to one validated DNS address. The URL retains the
	// original hostname for TLS verification and the HTTP Host header.
	transport := &http.Transport{TLSClientConfig: v.TLS, Proxy: nil, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, network, net.JoinHostPort(addr.String(), port))
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	nonce := identity.Random()
	q := url.Values{"nonce": {nonce}, "key": {key}}
	req, err := http.NewRequestWithContext(ctx, "GET", origin+"/registry/v1/probe?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("https_unreachable")
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 16385))
	closeErr := response.Body.Close()
	if response.StatusCode != http.StatusOK || readErr != nil || closeErr != nil || len(body) > 16384 {
		return nil, fmt.Errorf("invalid_https_probe")
	}
	check := func(body []byte) (*Probe, error) {
		var packet Packet
		var result Probe
		if json.Unmarshal(body, &packet) != nil || packet.Key != key || packet.Verify(&result) != nil || result.Nonce != nonce {
			return nil, fmt.Errorf("invalid_probe_signature")
		}
		if result.Compatibility != v.Expected {
			return &result, fmt.Errorf("incompatible_server")
		}
		return &result, nil
	}
	observed, err := check(body)
	if err != nil {
		return observed, err
	}
	socketURL := strings.Replace(origin, "https://", "wss://", 1)
	socketURL = strings.Replace(socketURL, "http://", "ws://", 1)
	q.Set("probe", nonce)
	conn, response, err := websocket.Dial(ctx, socketURL+"/ws?"+q.Encode(), &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": {v.Origin}}})
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close() //nolint:errcheck // Preserve the failed probe result.
		}
		return nil, fmt.Errorf("wss_unreachable")
	}
	defer conn.CloseNow() //nolint:errcheck // Probe cleanup never changes its result.
	conn.SetReadLimit(16384)
	kind, body, err := conn.Read(ctx)
	if err != nil || kind != websocket.MessageText {
		return nil, fmt.Errorf("invalid_wss_probe")
	}
	confirmed, err := check(body)
	if err != nil || confirmed.Release != observed.Release || confirmed.Compatibility != observed.Compatibility {
		return nil, fmt.Errorf("invalid_wss_probe")
	}
	return confirmed, nil
}
