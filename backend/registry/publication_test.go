package registry

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestFullPublicationUsesSeparateBudget(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p := Publication{Schema: PublicationSchemaVersion, ServerID: strings.Repeat("a", 32), Revision: 1, Rooms: []PublishedRoom{}, Staff: []Assignment{}}
	for i := range 32 {
		p.Rooms = append(p.Rooms, PublishedRoom{ID: fmt.Sprintf("%032x", i), Name: strings.Repeat("n", 60), Mode: "ctf", Map: strings.Repeat("m", 80), Details: &RoomDetails{MapID: "yard"}, Capacity: 16, Protocol: 1, Profile: strings.Repeat("f", 64)})
	}
	if err = p.Validate(); err != nil {
		t.Fatal(err)
	}
	packet, err := Sign(key, p)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Publication
	if packet.Verify(&decoded) == nil {
		t.Fatal("fixture must exceed probe budget")
	}
	if err = packet.VerifyLimit(&decoded, PublicationLimit); err != nil {
		t.Fatal(err)
	}
	p.Rooms = append(p.Rooms, p.Rooms[0])
	if p.Validate() == nil {
		t.Fatal("excess rooms accepted")
	}
	packet.Body = strings.Repeat("A", 2*PublicationLimit)
	if packet.VerifyLimit(&decoded, PublicationLimit) == nil {
		t.Fatal("oversized packet accepted")
	}
}

func TestPublicationValidatesRoomBreakdown(t *testing.T) {
	p := Publication{Schema: PublicationSchemaVersion, ServerID: strings.Repeat("a", 32), Revision: 1, Staff: []Assignment{}, Rooms: []PublishedRoom{{ID: strings.Repeat("b", 32), Name: "Room", Mode: "dm", Map: "Yard", Capacity: 8, Occupied: 4, Protocol: 1, Profile: strings.Repeat("f", 64)}}}
	for _, tc := range []struct {
		name    string
		details *RoomDetails
		valid   bool
	}{
		{"missing details", nil, false},
		{"separate participants", &RoomDetails{Players: 1, Bots: 2, Spectators: 1, MapID: "yard"}, true},
		{"inconsistent total", &RoomDetails{Players: 1, Bots: 1, Spectators: 1, MapID: "yard"}, false},
		{"negative count", &RoomDetails{Players: -1, Bots: 4, Spectators: 1, MapID: "yard"}, false},
		{"missing map", &RoomDetails{Players: 4}, false},
		{"negative limit", &RoomDetails{Players: 4, MapID: "yard", TimeLimitSeconds: -1}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p.Rooms[0].Details = tc.details
			if (p.Validate() == nil) != tc.valid {
				t.Fatal("unexpected validation")
			}
		})
	}
}

func TestPublicationRequiresDetailsInJSON(t *testing.T) {
	for _, tc := range []struct {
		name, details string
		valid         bool
	}{
		{"missing", "", false},
		{"null", `"details":null,`, false},
		{"populated", `"details":{"players":1,"bots":2,"spectators":1,"mapId":"yard","scoreLimit":50,"timeLimitSeconds":1800},`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := fmt.Sprintf(`{"schema":%d,"serverId":%q,"revision":1,"staff":[],"rooms":[{%s"id":%q,"name":"Room","mode":"dm","map":"Yard","occupied":4,"capacity":8,"protocol":1,"profile":%q}]}`, PublicationSchemaVersion, strings.Repeat("a", 32), tc.details, strings.Repeat("b", 32), strings.Repeat("f", 64))
			var p Publication
			if err := json.Unmarshal([]byte(data), &p); err != nil {
				t.Fatal(err)
			}
			if err := p.Validate(); (err == nil) != tc.valid {
				t.Fatalf("validation = %v, want valid %t", err, tc.valid)
			}
		})
	}
}
