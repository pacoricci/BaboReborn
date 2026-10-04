package central

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
)

func publicationServer(t *testing.T, s *Service, owner string, n int) (string, ed25519.PrivateKey) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := fmt.Sprintf("%032x", n)
	_, err = s.DB.Exec(`INSERT INTO registered_servers(id,owner_id,name,region,origin,public_key,operation_id,status,applied_revision,compatible,verified_contract,last_seen_at,last_verified_at) VALUES($1,$2,'Community','EU',$3,$4,'operation','active',1,TRUE,$5,$6,$6)`, id, owner, fmt.Sprintf("https://game-%d.example", n), registry.Public(key), s.contractStamp(), s.now())
	if err != nil {
		t.Fatal(err)
	}
	return id, key
}
func publicationPacket(t *testing.T, s *Service, key ed25519.PrivateKey, p registry.Publication) registry.Packet {
	t.Helper()
	p.Nonce = identity.ID()
	if _, err := s.DB.Exec("INSERT INTO registry_nonces(nonce,public_key,server_id,purpose,request_id,expires_at) VALUES($1,$2,$3,'publication',$4,$5)", p.Nonce, registry.Public(key), p.ServerID, identity.ID(), s.now().Add(nonceLifetime)); err != nil {
		t.Fatal(err)
	}
	packet, err := registry.Sign(key, p)
	if err != nil {
		t.Fatal(err)
	}
	return packet
}
func TestPublicationCatalogIsolationFreshnessAndAuthority(t *testing.T) {
	s := testService(t)
	s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
	owner, ownerID := accountCookie(t, s, "publication-owner")
	staff, staffID := accountCookie(t, s, "publication-staff")
	id, key := publicationServer(t, s, ownerID, 1)
	other, otherKey := publicationServer(t, s, ownerID, 2)
	now := s.now()
	s.Now = func() time.Time { return now }
	room := registry.PublishedRoom{ID: strings.Repeat("a", 32), Name: "Arena", Mode: "dm", Map: "Yard", Details: &registry.RoomDetails{MapID: "yard"}, Occupied: 0, Capacity: 16, Protocol: compatibility.Current().Protocol, Profile: compatibility.GameProfile()}
	p := registry.Publication{Schema: registry.PublicationSchemaVersion, ServerID: id, Revision: 1, Rooms: []registry.PublishedRoom{room}, Staff: []registry.Assignment{{Account: staffID, Role: "admin"}}}
	send := func(packet registry.Packet, want int) {
		t.Helper()
		status, b := portalRequest(t, s, "", "POST", "/registry/v1/publication", packet)
		if status != want {
			t.Fatalf("publication %d != %d: %s", status, want, b)
		}
	}
	packet := publicationPacket(t, s, key, p)
	send(packet, 200)
	send(packet, 401)
	p.ServerID = other
	send(publicationPacket(t, s, otherKey, p), 200)
	p.ServerID = id
	status, b := portalRequest(t, s, "", "GET", "/api/v1/rooms", nil)
	var catalog struct {
		Rooms []directoryRoom `json:"rooms"`
	}
	if err := json.Unmarshal(b, &catalog); err != nil {
		t.Fatal(err)
	}
	if status != 200 || len(catalog.Rooms) != 2 || catalog.Rooms[0].Ref == catalog.Rooms[1].Ref {
		t.Fatalf("global catalog %d %s", status, b)
	}
	for _, r := range catalog.Rooms {
		if r.ServerOrigin != "https://game-1.example" && r.ServerOrigin != "https://game-2.example" {
			t.Fatal("catalog missing registered probe origin", r.ServerOrigin)
		}
		status, _ = portalRequest(t, s, "", "GET", "/api/v1/rooms/"+r.Ref, nil)
		if status != 200 {
			t.Fatal("resolution", status)
		}
	}
	status, b = portalRequest(t, s, staff, "GET", "/api/v1/manage/servers/"+id, nil)
	if status != 200 || !strings.Contains(string(b), `"role":"admin"`) || strings.Contains(string(b), ownerID) {
		t.Fatalf("delegated view %d %s", status, b)
	}
	status, _ = portalRequest(t, s, staff, "DELETE", "/api/v1/manage/servers/"+id, nil)
	if status != 403 {
		t.Fatal("index granted ownership", status)
	}
	// An older request arriving after a new snapshot must not restore a closed room or role.
	now = now.Add(time.Second)
	old := publicationPacket(t, s, key, p)
	now = now.Add(time.Second)
	empty := p
	empty.Rooms = []registry.PublishedRoom{}
	empty.Staff = []registry.Assignment{}
	send(publicationPacket(t, s, key, empty), 200)
	send(old, 409)
	status, _ = portalRequest(t, s, staff, "GET", "/api/v1/manage/servers/"+id, nil)
	if status != 404 {
		t.Fatal("removed assignment persisted", status)
	}
	status, _ = portalRequest(t, s, "", "GET", "/api/v1/rooms/"+registry.RoomRef(id, room.ID), nil)
	if status != 404 {
		t.Fatal("closed room resolved", status)
	}
	now = now.Add(16 * time.Second)
	status, b = portalRequest(t, s, "", "GET", "/api/v1/rooms", nil)
	if status != 200 || !strings.Contains(string(b), `"rooms":[]`) {
		t.Fatal("stale rooms", status, string(b))
	}
	status, b = portalRequest(t, s, staff, "GET", "/api/v1/manage/servers/"+other, nil)
	if status != 200 || !strings.Contains(string(b), `"assignmentVerified":false`) {
		t.Fatal("offline assignment hint", status, string(b))
	}
	// Removing the registration invalidates even retained offline staff hints.
	status, _ = portalRequest(t, s, owner, "DELETE", "/api/v1/manage/servers/"+other, nil)
	if status != 200 {
		t.Fatal(status)
	}
	status, _ = portalRequest(t, s, staff, "GET", "/api/v1/manage/servers/"+other, nil)
	if status != 404 {
		t.Fatal(status)
	}
	s.publicationMu.Lock()
	s.publications = nil
	s.publicationMu.Unlock()
	owned, err := s.managementServers(context.Background(), ownerID)
	if err != nil || len(owned) != 1 {
		t.Fatal("restart lost owned registration", owned, err)
	}
}
func TestPublicationRejectsInvalidSnapshotsAndReplacedKeys(t *testing.T) {
	s := testService(t)
	s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
	_, owner := accountCookie(t, s, "owner")
	id, key := publicationServer(t, s, owner, 1)
	p := registry.Publication{Schema: registry.PublicationSchemaVersion, ServerID: id, Revision: 1, Rooms: []registry.PublishedRoom{}, Staff: []registry.Assignment{}}
	packet := publicationPacket(t, s, key, p)
	packet.Signature = "invalid"
	status, _ := portalRequest(t, s, "", "POST", "/registry/v1/publication", packet)
	if status != 400 {
		t.Fatal(status)
	}
	p.Rooms = []registry.PublishedRoom{{ID: strings.Repeat("a", 32), Name: "Arena", Mode: "dm", Map: "Yard", Capacity: 16, Protocol: compatibility.Current().Protocol, Profile: compatibility.GameProfile()}}
	status, _ = portalRequest(t, s, "", "POST", "/registry/v1/publication", publicationPacket(t, s, key, p))
	if status != 400 {
		t.Fatal("publication without room details accepted", status)
	}
	p.Rooms = []registry.PublishedRoom{}
	p.Staff = []registry.Assignment{{Account: owner, Role: "owner"}}
	status, _ = portalRequest(t, s, "", "POST", "/registry/v1/publication", publicationPacket(t, s, key, p))
	if status != 400 {
		t.Fatal("publisher asserted ownership", status)
	}
	p.Staff = []registry.Assignment{}
	p.Revision = 2
	status, _ = portalRequest(t, s, "", "POST", "/registry/v1/publication", publicationPacket(t, s, key, p))
	if status != 409 {
		t.Fatal("revision mismatch", status)
	}
	p.Revision = 1
	if _, err := s.DB.Exec("UPDATE registered_servers SET public_key=$2 WHERE id=$1", id, strings.Repeat("x", 43)); err != nil {
		t.Fatal(err)
	}
	status, _ = portalRequest(t, s, "", "POST", "/registry/v1/publication", publicationPacket(t, s, key, p))
	if status != 409 {
		t.Fatal("replaced key accepted", status)
	}
}
