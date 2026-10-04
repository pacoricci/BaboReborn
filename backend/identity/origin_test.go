package identity

import "testing"

func TestCanonicalOriginsMatchBrowserIdentity(t *testing.T) {
	for input, want := range map[string]string{"https://EXAMPLE.org:443/": "https://example.org", "https://Example.org:8443": "https://example.org:8443", "http://LOCALHOST:80": "http://localhost", "http://[0:0:0:0:0:0:0:1]:8080/": "http://[::1]:8080"} {
		got, err := CanonicalOrigin(input, true)
		if err != nil || got != want {
			t.Fatal(input, got, err)
		}
	}
	for _, input := range []string{"https://user@example.org", "https://example.org:0", "https://example.org:65536", "https://example.org/path", "https://example.org?a=1", "https://[fe80::1%25en0]", "http://192.168.1.1"} {
		if got, err := CanonicalOrigin(input, true); err == nil {
			t.Fatal("invalid origin accepted", got)
		}
	}
}
