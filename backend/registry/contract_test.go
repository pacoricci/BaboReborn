package registry

import (
	"crypto/ed25519"
	"crypto/rand"
	"net/netip"
	"testing"
)

func TestSignaturesBindExactPayloadAndKey(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	packet, err := Sign(key, Request{Action: "claim", Nonce: "nonce", Code: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	var request Request
	if err = packet.Verify(&request); err != nil || request.Code != "secret" {
		t.Fatal(request, err)
	}
	packet.Body += "a"
	if packet.Verify(&request) == nil {
		t.Fatal("tampered payload verified")
	}
}
func TestProbeAddressBoundary(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "::1", "::ffff:127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "2001:db8::1", "fc00::1", "fe80::1", "0.0.0.0"} {
		if PublicAddress(netip.MustParseAddr(ip)) {
			t.Error("non-public address accepted", ip)
		}
	}
	for _, ip := range []string{"1.1.1.1", "2606:4700:4700::1111"} {
		if !PublicAddress(netip.MustParseAddr(ip)) {
			t.Error("public address refused", ip)
		}
	}
}
