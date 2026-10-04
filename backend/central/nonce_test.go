package central

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
)

func signedNonceRequest(t *testing.T, key ed25519.PrivateKey, request registry.NonceRequest) registry.Packet {
	t.Helper()
	if request.RequestID == "" {
		request.RequestID = identity.ID()
	}
	packet, err := registry.Sign(key, request)
	if err != nil {
		t.Fatal(err)
	}
	return packet
}

func issueNonce(t *testing.T, s *Service, packet registry.Packet) (int, string, []byte) {
	t.Helper()
	status, body := portalRequest(t, s, "", "POST", "/registry/v1/nonce", packet)
	if status != 200 {
		return status, "", body
	}
	var response struct {
		Nonce string `json:"nonce"`
	}
	if err := json.Unmarshal(body, &response); err != nil || response.Nonce == "" {
		t.Fatalf("invalid nonce response: %d %s: %v", status, body, err)
	}
	return status, response.Nonce, body
}

func nonceCount(t *testing.T, s *Service, key string) int {
	t.Helper()
	var count int
	if err := s.DB.QueryRow("SELECT count(*) FROM registry_nonces WHERE public_key=$1", key).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func nonceKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestNonceRejectsAnonymousAndForgedInstallationsWithoutAllocation(t *testing.T) {
	s := testService(t)
	_, owner := accountCookie(t, s, "nonce-owner")
	id, authorizedKey := publicationServer(t, s, owner, 1)
	attackerKey := nonceKey(t)
	attackerPublic := registry.Public(attackerKey)
	authorizedPublic := registry.Public(authorizedKey)

	// Knowing the registered public key does not prove control of the installation.
	status, body := portalRequest(t, s, "", "POST", "/registry/v1/nonce", map[string]string{"key": authorizedPublic})
	if status == 200 {
		t.Fatalf("unsigned public-key request allocated a nonce: %s", body)
	}
	if got := nonceCount(t, s, authorizedPublic); got != 0 {
		t.Fatalf("unsigned request allocated %d nonces", got)
	}

	// A valid signature by an unrelated key cannot claim the registered server.
	unrelated := signedNonceRequest(t, attackerKey, registry.NonceRequest{Purpose: "ack", ServerID: id})
	status, _, body = issueNonce(t, s, unrelated)
	if status == 200 {
		t.Fatalf("unregistered key allocated a server nonce: %s", body)
	}
	if got := nonceCount(t, s, attackerPublic); got != 0 {
		t.Fatalf("unregistered key allocated %d nonces", got)
	}

	// Replacing the packet's key cannot redirect a signature onto a victim's quota.
	forged := unrelated
	forged.Key = authorizedPublic
	status, _, body = issueNonce(t, s, forged)
	if status == 200 {
		t.Fatalf("forged public key allocated a nonce: %s", body)
	}
	if got := nonceCount(t, s, authorizedPublic); got != 0 {
		t.Fatalf("forged request allocated %d victim nonces", got)
	}
}

func TestNoncePairingCodeBindsFirstPendingKeyAndLimitsAllocation(t *testing.T) {
	s := testService(t)
	cookie, _ := accountCookie(t, s, "nonce-pairing-owner")
	_, code := management(t, s, cookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Pending", "region": "EU", "origin": "https://pending.example.org"})
	firstKey, secondKey := nonceKey(t), nonceKey(t)
	firstPublic, secondPublic := registry.Public(firstKey), registry.Public(secondKey)
	firstPacket := signedNonceRequest(t, firstKey, registry.NonceRequest{Purpose: "claim", Code: code})
	status, firstNonce, body := issueNonce(t, s, firstPacket)
	if status != 200 {
		t.Fatalf("first installation could not use pairing code: %d %s", status, body)
	}

	// A code is committed to one key when the first nonce is issued, before claim.
	status, _, body = issueNonce(t, s, signedNonceRequest(t, secondKey, registry.NonceRequest{Purpose: "claim", Code: code}))
	if status == 200 {
		t.Fatalf("second installation reused pending code: %s", body)
	}
	if got := nonceCount(t, s, secondPublic); got != 0 {
		t.Fatalf("second key allocated %d nonces", got)
	}

	// Repeating the exact signed request returns its nonce without spending quota.
	status, repeatedNonce, body := issueNonce(t, s, firstPacket)
	if status != 200 || repeatedNonce != firstNonce || nonceCount(t, s, firstPublic) != 1 {
		t.Fatalf("nonce request was not idempotent: %d %s", status, body)
	}
	for range 7 {
		status, _, body = issueNonce(t, s, signedNonceRequest(t, firstKey, registry.NonceRequest{Purpose: "claim", Code: code}))
		if status != 200 {
			t.Fatalf("authorized nonce below quota denied: %d %s", status, body)
		}
	}
	if got := nonceCount(t, s, firstPublic); got != 8 {
		t.Fatalf("expected eight outstanding nonces, got %d", got)
	}
	status, _, body = issueNonce(t, s, signedNonceRequest(t, firstKey, registry.NonceRequest{Purpose: "claim", Code: code}))
	if status != 429 || !strings.Contains(string(body), "nonce_limit") {
		t.Fatalf("ninth outstanding nonce admitted or misclassified: %d %s", status, body)
	}
	status, repeatedNonce, body = issueNonce(t, s, firstPacket)
	if status != 200 || repeatedNonce != firstNonce || nonceCount(t, s, firstPublic) != 8 {
		t.Fatalf("retry at quota allocated another nonce: %d %s", status, body)
	}
}

func TestNonceIsBoundToPurposeAndConsumedRequestCannotReissue(t *testing.T) {
	s := testService(t)
	s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
	_, owner := accountCookie(t, s, "nonce-purpose-owner")
	id, key := publicationServer(t, s, owner, 1)
	packet := signedNonceRequest(t, key, registry.NonceRequest{Purpose: "ack", ServerID: id})
	status, nonce, body := issueNonce(t, s, packet)
	if status != 200 {
		t.Fatalf("registered installation could not issue nonce: %d %s", status, body)
	}

	wrongPurpose, err := registry.Sign(key, registry.Request{Action: "heartbeat", ServerID: id, Nonce: nonce})
	if err != nil {
		t.Fatal(err)
	}
	status, body = portalRequest(t, s, "", "POST", "/registry/v1/request", wrongPurpose)
	if status != 401 || !strings.Contains(string(body), "invalid_nonce") {
		t.Fatalf("nonce crossed action boundary: %d %s", status, body)
	}
	wrongPublication, err := registry.Sign(key, registry.Publication{Schema: registry.PublicationSchemaVersion, ServerID: id, Revision: 1, Nonce: nonce, Rooms: []registry.PublishedRoom{}, Staff: []registry.Assignment{}})
	if err != nil {
		t.Fatal(err)
	}
	status, body = portalRequest(t, s, "", "POST", "/registry/v1/publication", wrongPublication)
	if status != 401 || !strings.Contains(string(body), "invalid_nonce") {
		t.Fatalf("nonce crossed publication boundary: %d %s", status, body)
	}

	valid, err := registry.Sign(key, registry.Request{Action: "ack", ServerID: id, Revision: 1, Nonce: nonce})
	if err != nil {
		t.Fatal(err)
	}
	status, body = portalRequest(t, s, "", "POST", "/registry/v1/request", valid)
	if status != 200 {
		t.Fatalf("valid action lost nonce after wrong-purpose attempt: %d %s", status, body)
	}
	status, body = portalRequest(t, s, "", "POST", "/registry/v1/request", valid)
	if status != 401 || !strings.Contains(string(body), "invalid_nonce") {
		t.Fatalf("consumed nonce replayed: %d %s", status, body)
	}
	status, _, body = issueNonce(t, s, packet)
	if status == 200 {
		t.Fatalf("consumed nonce request reissued: %s", body)
	}
}

func TestRemovedServerCannotRetainOrIssueNonces(t *testing.T) {
	s := testService(t)
	cookie, owner := accountCookie(t, s, "removed-nonce-owner")
	id, key := publicationServer(t, s, owner, 1)
	packet := signedNonceRequest(t, key, registry.NonceRequest{Purpose: "heartbeat", ServerID: id})
	status, _, body := issueNonce(t, s, packet)
	if status != 200 || nonceCount(t, s, registry.Public(key)) != 1 {
		t.Fatalf("active server did not receive nonce: %d %s", status, body)
	}
	status, body = portalRequest(t, s, cookie, "DELETE", "/api/v1/manage/servers/"+id, nil)
	if status != 200 || nonceCount(t, s, registry.Public(key)) != 0 {
		t.Fatalf("removal retained outstanding nonce: %d %s", status, body)
	}
	status, _, body = issueNonce(t, s, signedNonceRequest(t, key, registry.NonceRequest{Purpose: "heartbeat", ServerID: id}))
	if status != 409 || !strings.Contains(string(body), "server_removed") || nonceCount(t, s, registry.Public(key)) != 0 {
		t.Fatalf("removed server allocated nonce: %d %s", status, body)
	}
}
