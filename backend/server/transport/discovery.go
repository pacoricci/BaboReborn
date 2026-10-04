package transport

import (
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/registry"
)

const ServerInfoSchemaVersion = 1

// ServerInfo is a small public snapshot. HTTP/socket handlers never read live world state.
type ServerInfo struct {
	Details  *registry.RoomDetails `json:"details"`
	Schema   int                   `json:"schema"`
	Name     string                `json:"name"`
	Mode     string                `json:"mode"`
	Map      string                `json:"map"`
	Protocol int                   `json:"protocol"`
	Profile  string                `json:"profile"`
	Occupied int                   `json:"occupied"`
	Capacity int                   `json:"capacity"`
}

// Names are presentation metadata and can change without replacing a match.
func (s *Server) SetName(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.info.Name = name
}
func (s *Server) Info() ServerInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info
}

// Called only by the simulation owner (or during initial composition).
func (s *Server) updateInfo() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.info.Map = s.world.Arena.Name
	s.info.Occupied = len(s.world.Players)
	d := &registry.RoomDetails{MapID: s.world.Arena.ID, ScoreLimit: s.world.Rules.ScoreLimit, TimeLimitSeconds: s.world.Rules.TimeLimitTicks / gameconfig.TickHz}
	for _, p := range s.world.Players {
		switch {
		case p.IsBot():
			d.Bots++
		case p.Status == "spectator":
			d.Spectators++
		default:
			d.Players++
		}
	}
	s.info.Details = d
}
