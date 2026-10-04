// Package hosting owns in-memory room instances; persistence and authorization are outside it.
package hosting

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/identity"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/transport"
)

type Config struct {
	Mode             string   `json:"mode"`
	Name             string   `json:"name"`
	Capacity         int      `json:"capacity"`
	Bots             int      `json:"bots"`
	Rotation         []string `json:"rotation"`
	ScoreLimit       int      `json:"scoreLimit"`
	TimeLimitMinutes int      `json:"timeLimitMinutes"`
	RespawnSeconds   int      `json:"respawnSeconds"`
	ForceRespawn     bool     `json:"forceRespawn"`
}

type MapInfo struct {
	CTF  bool   `json:"ctf"`
	ID   string `json:"id"`
	Name string `json:"name"`
}
type RoomInfo struct {
	ID   string               `json:"id"`
	Info transport.ServerInfo `json:"info"`
}

const DirectorySchemaVersion = 1

type Directory struct {
	Schema        int        `json:"schema"`
	Rooms         []RoomInfo `json:"rooms"`
	Maps          []MapInfo  `json:"maps"`
	MaxRooms      int        `json:"maxRooms"`
	CreatedRoomID string     `json:"createdRoomId,omitempty"`
}

type room struct {
	server  *transport.Server
	handler http.Handler
	cancel  context.CancelFunc
}
type Factory func(context.Context, Config) (*transport.Server, error)
type Manager struct {
	mu       sync.Mutex
	ctx      context.Context
	rooms    map[string]*room
	catalog  []MapInfo
	factory  Factory
	maxRooms int
	admit    transport.Admission
	origin   string
}

func New(ctx context.Context, catalog []MapInfo, factory Factory, maxRooms int) *Manager {
	if maxRooms < 1 || maxRooms > 32 {
		panic("max rooms must be 1..32")
	}
	m := &Manager{ctx: ctx, rooms: map[string]*room{}, factory: factory, maxRooms: maxRooms}
	for _, a := range catalog {
		m.catalog = append(m.catalog, MapInfo{ID: a.ID, Name: a.Name, CTF: a.CTF})
	}
	return m
}
func (m *Manager) SetOrigin(origin string)                { m.origin = origin }
func (m *Manager) SetAdmission(admit transport.Admission) { m.admit = admit }
func (m *Manager) Prepare(ctx context.Context, c Config) (*transport.Server, error) {
	if err := m.Validate(c); err != nil {
		return nil, err
	}
	s, err := m.factory(ctx, c)
	if err != nil {
		return nil, err
	}
	s.SetAdmission(m.admit)
	s.SetOrigin(m.origin)
	return s, nil
}
func (m *Manager) Install(id string, s *transport.Server) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx.Err() != nil {
		return m.ctx.Err()
	}
	if m.rooms[id] != nil {
		return fmt.Errorf("room already exists")
	}
	if len(m.rooms) >= m.maxRooms {
		return fmt.Errorf("room limit reached")
	}
	ctx, cancel := context.WithCancel(m.ctx)
	m.rooms[id] = &room{server: s, handler: s.Handler(ctx), cancel: cancel}
	go s.Run(ctx)
	return nil
}
func (m *Manager) Remove(ctx context.Context, id string, restart bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[id]
	if r == nil {
		return fmt.Errorf("room not found")
	}
	code, reason := transport.CloseRoomClosed, transport.ReasonRoomClosed
	if restart {
		code, reason = transport.CloseRoomRestarted, transport.ReasonRoomRestarted
	}
	if _, err := r.server.Apply(ctx, transport.Administration{Action: transport.Retire, Code: code, Reason: reason}); err != nil && !r.server.Retiring() {
		return err
	}
	// Once retirement was delivered, a cancelled caller cannot leave a
	// permanently closed room in the directory. The old handler has its own
	// bounded shutdown even if the owner never acknowledges this command.
	delete(m.rooms, id)
	// Allow Close's bounded handshake to finish before cancelling the old handler.
	// The world is already empty; the replacement can start immediately.
	time.AfterFunc(6*time.Second, r.cancel)
	return nil
}
func (m *Manager) Apply(ctx context.Context, command transport.Administration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rooms {
		if _, err := r.server.Apply(ctx, command); err != nil {
			return err
		}
	}
	return nil
}
func (m *Manager) NotifyRoom(ctx context.Context, id string, notice transport.Notice) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[id]
	if r == nil {
		return fmt.Errorf("room not found")
	}
	_, err := r.server.Apply(ctx, transport.Administration{Action: transport.Notify, Notice: notice})
	return err
}
func (m *Manager) Rename(id, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rooms[id]
	if r == nil {
		return fmt.Errorf("room not found")
	}
	r.server.SetName(name)
	return nil
}

type Participant struct {
	transport.Participant
	Room string `json:"room"`
}

func (m *Manager) Participants(ctx context.Context) ([]Participant, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	all := []Participant{}
	for id, r := range m.rooms {
		people, err := r.server.Apply(ctx, transport.Administration{Action: transport.ListParticipants})
		if err != nil {
			return nil, err
		}
		for _, person := range people {
			all = append(all, Participant{Participant: person, Room: id})
		}
	}
	return all, nil
}
func (m *Manager) Directory() Directory {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := Directory{Schema: DirectorySchemaVersion, Rooms: []RoomInfo{}, Maps: m.catalog, MaxRooms: m.maxRooms}
	for id, r := range m.rooms {
		d.Rooms = append(d.Rooms, RoomInfo{ID: id, Info: r.server.Info()})
	}
	return d
}
func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/health" {
		identity.JSON(w, http.StatusOK, map[string]any{"status": "ok", "protocol": gameconfig.ProtocolVersion})
		return
	}
	if r.URL.Query().Get("rooms") == "1" {
		identity.Error(w, http.StatusGone, "use_http_room_api")
		return
	}
	m.mu.Lock()
	room := m.rooms[r.URL.Query().Get("room")]
	m.mu.Unlock()
	if room == nil {
		identity.Error(w, http.StatusNotFound, "room_unavailable")
		return
	}
	room.handler.ServeHTTP(w, r)
}
func (m *Manager) Validate(c Config) error {
	if c.Mode != "" && !match.ValidMode(c.Mode) {
		return fmt.Errorf("unknown game mode")
	}
	if len(strings.TrimSpace(c.Name)) == 0 || len(utf16.Encode([]rune(c.Name))) > 60 || strings.ContainsAny(c.Name, "\r\n\t") {
		return fmt.Errorf("use a room name of 1–60 characters")
	}
	if c.Capacity < 2 || c.Capacity > 16 {
		return fmt.Errorf("choose 2–16 total slots")
	}
	if c.Bots < 0 || c.Bots >= c.Capacity {
		return fmt.Errorf("bots must leave at least one human slot")
	}
	if c.ScoreLimit < 0 || c.ScoreLimit > 1000 || c.TimeLimitMinutes < 0 || c.TimeLimitMinutes > 180 || c.RespawnSeconds < 0 || c.RespawnSeconds > 30 {
		return fmt.Errorf("use 0–1000 points, 0–180 minutes and 0–30 seconds for respawn")
	}
	if len(c.Rotation) == 0 || len(c.Rotation) > 16 {
		return fmt.Errorf("choose 1–16 maps in rotation")
	}
	for _, id := range c.Rotation {
		found := false
		for _, a := range m.catalog {
			if a.ID == id && (c.Mode != match.ModeCTF || a.CTF) {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("map is unknown or incompatible with this mode")
		}
	}
	return nil
}
