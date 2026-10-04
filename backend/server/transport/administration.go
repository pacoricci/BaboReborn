package transport

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

var (
	errRoomStopped = errors.New("room_stopped")
	errServerFull  = errors.New("server_full")
)

type roomClosure struct {
	code   websocket.StatusCode
	reason string
}

// Identity is admission metadata, not simulation state or an authentication token.
type Identity struct {
	Subject string
	Session string
	Expires time.Time
}
type Participant struct {
	ID             int    `json:"id"`
	Subject        string `json:"subject"`
	Nickname       string `json:"nickname"`
	NicknameColors string `json:"nicknameColors,omitempty"`
}
type Administration struct {
	Action  AdministrationAction
	Subject string
	Session string
	Reason  string
	Code    websocket.StatusCode
	Expires time.Time
	Notice  Notice
}

// AdministrationAction is what the room owner applies to the matching peers.
type AdministrationAction string

const (
	ListParticipants AdministrationAction = "participants"
	Disconnect       AdministrationAction = "disconnect"
	// Retire closes admission, then disconnects every peer.
	Retire AdministrationAction = "retire"
	Renew  AdministrationAction = "renew"
	Notify AdministrationAction = "notify"
)

// Deadline remains a host time until the room adapter converts it to delivery time.
type Notice struct {
	Action    NoticeAction
	Operation string
	Deadline  time.Time
}

// NoticeAction is sent to browsers in administration messages; see
// ADMINISTRATION_ACTIONS in frontend/src/contracts/session.ts.
type NoticeAction string

const (
	NoticeRestart            NoticeAction = "restart"
	NoticeClose              NoticeAction = "close"
	NoticeCancelled          NoticeAction = "cancelled"
	NoticePermissionsChanged NoticeAction = "permissions_changed"
)

type administrativeRequest struct {
	command Administration
	done    chan []Participant
}
type Admission func(*http.Request, func(Identity) error) error

// SetAdmission is composition-only and runs before the server starts.
func (s *Server) SetOrigin(origin string)      { s.origin = origin }
func (s *Server) SetAdmission(admit Admission) { s.admit = admit }
func (s *Server) Retiring() bool               { return s.retirement.Load() != nil }
func (s *Server) Apply(ctx context.Context, command Administration) ([]Participant, error) {
	request := administrativeRequest{command: command, done: make(chan []Participant, 1)}
	select {
	case s.administration <- request:
	case <-s.done:
		return nil, errRoomStopped
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if command.Action == Retire {
		// A successful unbuffered send means the owner received retirement.
		// Close admission before observing cancellation of its acknowledgement.
		s.retirement.CompareAndSwap(nil, &roomClosure{code: command.Code, reason: command.Reason})
	}
	select {
	case <-s.done:
		return nil, errRoomStopped
	case result := <-request.done:
		return result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Authentication is the first frame and the only way to renew a socket identity.
type Authentication struct {
	Type    string `json:"type"`
	Version int    `json:"version"`
	Proof   string `json:"proof,omitempty"`
	Guest   string `json:"guest,omitempty"`
}
