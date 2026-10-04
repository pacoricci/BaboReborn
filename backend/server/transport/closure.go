package transport

import "github.com/coder/websocket"

// Session closures are a browser contract: CLOSE and CLOSE_REASON in
// frontend/src/contracts/session.ts interpret them, and
// testdata/session-contract.json pins both languages.

// Close codes. The browser rejoins after a restart and leaves the room for
// every other application code.
const (
	CloseRoomRestarted websocket.StatusCode = 4001
	// Invalid messages, identity or server registration.
	CloseRejected websocket.StatusCode = 4002
	// Staff action, a newer session, idleness or failed delivery; replication
	// reasons also use this code.
	CloseRemoved    websocket.StatusCode = 4003
	CloseRoomClosed websocket.StatusCode = 4004
	// Admission found no free slot; a rejoining browser stops retrying.
	CloseRoomFull = websocket.StatusTryAgainLater
)

// Close reasons. The browser explains the ones it knows and shows the others
// as text.
const (
	ReasonRoomRestarted         = "room_restarted"
	ReasonRoomClosed            = "room_closed"
	ReasonAuthenticationExpired = "authentication_expired"
	ReasonServerRemoved         = "server_removed"
	ReasonInvalidProbe          = "invalid_probe"
	ReasonInvalidGeneration     = "invalid_generation"
	ReasonInvalidInput          = "invalid_input"
	ReasonSanctionActive        = "sanction_active"
	ReasonKicked                = "kicked"
	ReasonGameSessionReplaced   = "game_session_replaced"
	ReasonInputIdle             = "input_idle"
)
