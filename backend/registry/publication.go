package registry

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

const PublicationSchemaVersion = 1
const PublicationInterval = 5 * time.Second
const PublicationLifetime = 15 * time.Second
const PublicationLimit = 1024 * 1024

var identifier = regexp.MustCompile(`^[a-f0-9]{32}$`)
var fingerprint = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Mode codes mirror match.ModeDM, ModeTDM and ModeCTF; registry stays independent of match.
func validMode(mode string) bool { return mode == "dm" || mode == "tdm" || mode == "ctf" }

func ValidID(value string) bool          { return identifier.MatchString(value) }
func RoomRef(server, room string) string { return server + "." + room }
func ParseRoomRef(value string) (string, string, bool) {
	server, room, ok := strings.Cut(value, ".")
	return server, room, ok && ValidID(server) && ValidID(room)
}

// RoomDetails describes participant counts, the map identifier, and match limits.
type RoomDetails struct {
	Players          int    `json:"players"`
	Bots             int    `json:"bots"`
	Spectators       int    `json:"spectators"`
	MapID            string `json:"mapId"`
	ScoreLimit       int    `json:"scoreLimit"`
	TimeLimitSeconds int    `json:"timeLimitSeconds"`
}

type PublishedRoom struct {
	Details  *RoomDetails `json:"details"`
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Mode     string       `json:"mode"`
	Map      string       `json:"map"`
	Occupied int          `json:"occupied"`
	Capacity int          `json:"capacity"`
	Protocol int          `json:"protocol"`
	Profile  string       `json:"profile"`
}
type Assignment struct {
	Account string `json:"account"`
	Role    string `json:"role"`
}
type Publication struct {
	Schema   int             `json:"schema"`
	Nonce    string          `json:"nonce"`
	ServerID string          `json:"serverId"`
	Revision int64           `json:"revision"`
	Rooms    []PublishedRoom `json:"rooms"`
	Staff    []Assignment    `json:"staff"`
}

func (p Publication) Validate() error {
	if p.Schema != PublicationSchemaVersion || !ValidID(p.ServerID) || p.Revision < 1 || p.Rooms == nil || p.Staff == nil || len(p.Rooms) > 32 {
		return fmt.Errorf("invalid_publication")
	}
	seen := map[string]bool{}
	for _, r := range p.Rooms {
		if !ValidID(r.ID) || seen[r.ID] || strings.TrimSpace(r.Name) == "" || len(r.Name) > 240 || r.Map == "" || len(r.Map) > 320 || !validMode(r.Mode) || r.Capacity < 2 || r.Capacity > 16 || r.Occupied < 0 || r.Occupied > r.Capacity || r.Protocol < 1 || !fingerprint.MatchString(r.Profile) {
			return fmt.Errorf("invalid_published_room")
		}
		d := r.Details
		if d == nil || d.Players < 0 || d.Players > r.Capacity || d.Bots < 0 || d.Bots > r.Capacity || d.Spectators < 0 || d.Spectators > r.Capacity || d.Players+d.Bots+d.Spectators != r.Occupied || d.MapID == "" || len(d.MapID) > 320 || d.ScoreLimit < 0 || d.TimeLimitSeconds < 0 {
			return fmt.Errorf("invalid_room_details")
		}
		seen[r.ID] = true
	}
	seen = map[string]bool{}
	for _, a := range p.Staff {
		if !ValidID(a.Account) || seen[a.Account] || (a.Role != "admin" && a.Role != "moderator") {
			return fmt.Errorf("invalid_published_staff")
		}
		seen[a.Account] = true
	}
	return nil
}
