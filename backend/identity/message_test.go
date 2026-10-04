package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

func TestRegistryResponsesAreBoundToIssuerNonceAndPurpose(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := NewSigner(key, "key", "https://portal.example")
	if err != nil {
		t.Fatal(err)
	}
	keys := jose.JSONWebKeySet{Keys: []jose.JSONWebKey{signer.Public}}
	proof, err := signer.SignRegistry("one", map[string]int{"revision": 7})
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]int
	if err = VerifyRegistry(proof, signer.Issuer, "one", keys, &value); err != nil || value["revision"] != 7 {
		t.Fatal(value, err)
	}
	for _, pair := range [][2]string{{signer.Issuer, "two"}, {"https://other.example", "one"}, {signer.Issuer, ""}} {
		if err = VerifyRegistry(proof, pair[0], pair[1], keys, &value); err == nil {
			t.Fatal("replayed registry response", pair)
		}
	}
	if _, err = Verify(proof, signer.Issuer, "server", keys, time.Now()); err == nil {
		t.Fatal("registry response became an access proof")
	}
	tokens, err := signer.Issue("owner", "server", "session", time.Now(), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err = VerifyRegistry(tokens.Proof, signer.Issuer, "one", keys, &value); err == nil {
		t.Fatal("access proof became a registry response")
	}
}
