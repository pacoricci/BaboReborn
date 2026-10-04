// Package transport adapts WebSocket JSON to the single authoritative simulation owner.
package transport

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/identity"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

type Message struct {
	Generation     int                  `json:"generation,omitempty"`
	Receipt        *replication.Receipt `json:"receipt,omitempty"`
	Nickname       string               `json:"nickname,omitempty"`
	NicknameColors string               `json:"nicknameColors,omitempty"`
	Appearance     wire.Appearance      `json:"appearance,omitempty"`
	Type           string               `json:"type"`
	Version        int                  `json:"version"`
	Inputs         []match.Command      `json:"inputs,omitempty"`
	Primary        string               `json:"primary,omitempty"`
	Secondary      string               `json:"secondary,omitempty"`
	Nonce          float64              `json:"nonce,omitempty"`
}
type peer struct {
	closing           atomic.Bool
	identity          Identity
	id                int
	conn              *websocket.Conn
	connection        string
	waiter            chan deliveryResult
	round             int
	install           bool
	lastResync        time.Time
	cancel            context.CancelFunc
	window            time.Time
	messages          int
	replaced, dropped int
	inputEmpty        bool
	inputTrace        uint64
}
type incoming struct {
	peer     *peer
	message  Message
	err      error
	received time.Time
}
type registration struct {
	peer *peer
	done chan bool
}
type Server struct {
	done            chan struct{}
	retirement      atomic.Pointer[roomClosure]
	ContentRevision string
	origin          string
	admit           Admission
	administration  chan administrativeRequest
	delivery        chan deliveryRequest
	world           *match.World
	capacity        int
	register        chan registration
	incoming        chan incoming
	mu              sync.Mutex
	stats           Stats
	trace           deliveryTrace
	origins         []string
	info            ServerInfo
}

func New(w *match.World, capacity int, origins []string) *Server {
	if capacity < 2 || capacity > match.MaxPlayers {
		panic("capacity must be 2..16")
	}
	if len(w.Players) > capacity {
		panic("initial players exceed server capacity")
	}
	s := &Server{done: make(chan struct{}), delivery: make(chan deliveryRequest), administration: make(chan administrativeRequest), world: w, capacity: capacity, origins: origins, register: make(chan registration), incoming: make(chan incoming, 256)}
	s.info = ServerInfo{Schema: ServerInfoSchemaVersion, Name: "Community server", Mode: w.Rules.Mode, Map: w.Arena.Name, Protocol: gameconfig.ProtocolVersion, Profile: compatibility.GameProfile(), Capacity: capacity}
	s.updateInfo()
	return s
}
func encode(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
func (s *Server) Handler(ctx context.Context) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/diagnostics", s.diagnostics)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-s.done:
			identity.Error(w, http.StatusServiceUnavailable, "room_stopped")
			return
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write(encode(map[string]any{"status": "ok", "protocol": gameconfig.ProtocolVersion})); err != nil {
			log.Printf("Health response: %v", err)
		}
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(s.Stats()); err != nil {
			log.Printf("Metrics response: %v", err)
		}
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) { s.serveSocket(ctx, w, r) })
	return mux
}
func (s *Server) Run(ctx context.Context) {
	ticker := time.NewTicker(tickPeriod)
	defer ticker.Stop()
	s.run(ctx, ticker.C, time.Now)
}
