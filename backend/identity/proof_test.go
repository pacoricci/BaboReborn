package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"path/filepath"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

func TestProofBoundariesAndRotation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner(key, "old", "https://central.test")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.FixedZone("test", 2*60*60))
	tokens, err := signer.Issue("account", "server-a", "session", now, now.Add(SessionLifetime))
	if err != nil {
		t.Fatal(err)
	}
	if tokens.ExpiresAt.Location() != time.UTC {
		t.Fatal("HTTP proof expiry must use UTC", tokens.ExpiresAt)
	}
	keys := jose.JSONWebKeySet{Keys: []jose.JSONWebKey{signer.Public}}
	claims, err := Verify(tokens.Proof, signer.Issuer, "server-a", keys, now)
	if err != nil || claims.Subject != "account" || claims.Session != "session" {
		t.Fatalf("claims %v %v", claims, err)
	}
	for _, input := range []struct {
		issuer, audience, proof string
		at                      time.Time
	}{
		{signer.Issuer, "server-b", tokens.Proof, now}, {"https://wrong.test", "server-a", tokens.Proof, now},
		{signer.Issuer, "server-a", tokens.Proof, now.Add(ProofLifetime)},
		{signer.Issuer, "server-a", tokens.Proof, now.Add(-time.Second)},
		{signer.Issuer, "server-a", tokens.Proof + "x", now},
	} {
		if _, err := Verify(input.proof, input.issuer, input.audience, keys, input.at); err == nil {
			t.Fatal("accepted invalid proof", input)
		}
	}
	next, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := NewSigner(next, "new", signer.Issuer)
	if err != nil {
		t.Fatal(err)
	}
	expanded := jose.JSONWebKeySet{Keys: []jose.JSONWebKey{signer.Public, rotated.Public}}
	if _, err := Verify(tokens.Proof, signer.Issuer, "server-a", expanded, now); err != nil {
		t.Fatal(err)
	}
	fresh, err := rotated.Issue("account", "server-a", "session", now, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(fresh.Proof, signer.Issuer, "server-a", keys, now); err == nil {
		t.Fatal("accepted unknown key")
	}
	if _, err := Verify(fresh.Proof, signer.Issuer, "server-a", expanded, now); err != nil {
		t.Fatal(err)
	}
	if !fresh.ExpiresAt.Equal(now.Add(time.Minute)) {
		t.Fatal("proof exceeded session expiration")
	}
}
func TestKeyFilesPreservePublishedKeys(t *testing.T) {
	dir := t.TempDir()
	public := filepath.Join(dir, "keys.json")
	for _, kid := range []string{"one", "two"} {
		if err := GenerateKey(filepath.Join(dir, kid+".pem"), public, kid); err != nil {
			t.Fatal(err)
		}
	}
	keys, err := LoadKeys(public)
	if err != nil || len(keys.Keys) != 2 {
		t.Fatalf("keys %v %v", keys, err)
	}
	if err := GenerateKey(filepath.Join(dir, "three.pem"), public, "two"); err == nil {
		t.Fatal("reused key ID")
	}
}
