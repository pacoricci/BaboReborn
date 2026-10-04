package transport

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/identity"
	"baboreborn/backend/server/replication"
)

// serveSocket admits one player, then runs its writer and reader until either
// ends. Discovery (?info=1) shares the upgrade policy without taking a slot.
func (s *Server) serveSocket(ctx context.Context, w http.ResponseWriter, r *http.Request) {
	discovery := r.URL.Query().Get("info") == "1"
	if status, reason := s.refuseUpgrade(r, discovery); status != 0 {
		identity.Error(w, status, reason)
		return
	}
	// The exact configured origin was checked above, including its scheme.
	// HTTP Host is the community endpoint, not the portal origin.
	// Independent compressed messages preserve replaceable snapshots and avoid
	// retaining a compression dictionary per peer. Small messages stay plain.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.origins, InsecureSkipVerify: s.origin != "", CompressionMode: websocket.CompressionNoContextTakeover})
	if err != nil {
		return
	}
	defer conn.CloseNow() //nolint:errcheck // Final cleanup may find the socket already closed.
	if discovery {
		writeCtx, end := context.WithTimeout(ctx, 2*time.Second)
		defer end()
		_ = conn.Write(writeCtx, websocket.MessageText, encode(s.Info())) //nolint:errcheck // Discovery ends even if the visitor disconnects.
		return
	}
	conn.SetReadLimit(8192)
	initial, ok := readAuthentication(ctx, conn)
	if !ok {
		_ = conn.Close(websocket.StatusPolicyViolation, "authentication_required") //nolint:errcheck // Deferred cleanup owns the socket.
		return
	}
	r = withCredentials(r, initial.Proof, initial.Guest)
	clientCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	p := &peer{conn: conn, connection: rand.Text(), cancel: cancel}
	admitted, err := s.admitPeer(ctx, r, p)
	if err != nil {
		_ = conn.Close(s.rejection(err)) //nolint:errcheck // Always followed by socket cleanup.
		return
	}
	go s.runWriter(clientCtx, p)
	defer func() {
		select {
		case s.incoming <- incoming{peer: p, err: io.EOF}:
		case <-s.done:
		case <-ctx.Done():
		}
	}()
	s.readMessages(clientCtx, r, p, admitted)
}

// refuseUpgrade returns a nonzero HTTP status when the socket must not open.
func (s *Server) refuseUpgrade(r *http.Request, discovery bool) (int, string) {
	select {
	case <-s.done:
		return http.StatusServiceUnavailable, "room_stopped"
	default:
	}
	query := r.URL.Query()
	switch {
	case s.retirement.Load() != nil:
		return http.StatusServiceUnavailable, "room_stopped"
	case !discovery && s.ContentRevision != "" && query.Get("content") != s.ContentRevision:
		return http.StatusUpgradeRequired, "content_changed"
	case !discovery && (query.Get("v") != strconv.Itoa(gameconfig.ProtocolVersion) || query.Get("profile") != s.info.Profile):
		return http.StatusUpgradeRequired, "incompatible_client"
	case s.origin != "" && r.Header.Get("Origin") != s.origin:
		return http.StatusForbidden, "origin_refused"
	}
	return 0, ""
}

// The first frame must authenticate as a proof or a guest, never both.
func readAuthentication(ctx context.Context, conn *websocket.Conn) (Authentication, bool) {
	readCtx, end := context.WithTimeout(ctx, 5*time.Second)
	defer end()
	kind, data, err := conn.Read(readCtx)
	var a Authentication
	if err != nil || kind != websocket.MessageText || json.Unmarshal(data, &a) != nil || a.Type != "authenticate" || a.Version != gameconfig.ProtocolVersion || a.Proof != "" && a.Guest != "" {
		return Authentication{}, false
	}
	return a, true
}

// Admission reads credentials from headers; only socket-supplied ones count.
func withCredentials(r *http.Request, proof, guest string) *http.Request {
	r = r.Clone(r.Context())
	r.Header.Del("Authorization")
	r.Header.Del("X-Guest-ID")
	if proof != "" {
		r.Header.Set("Authorization", "Bearer "+proof)
	} else {
		r.Header.Set("X-Guest-ID", guest)
	}
	return r
}

// admitPeer lets the admission policy choose the identity that joins the room.
func (s *Server) admitPeer(ctx context.Context, r *http.Request, p *peer) (Identity, error) {
	var admitted Identity
	join := func(who Identity) error {
		admitted = who
		return s.join(ctx, p, who)
	}
	var err error
	if s.admit != nil {
		err = s.admit(r, join)
	} else {
		err = join(Identity{})
	}
	return admitted, err
}

// join hands the peer to the room owner and waits for its slot decision.
func (s *Server) join(ctx context.Context, p *peer, who Identity) error {
	p.identity = who
	done := make(chan bool, 1)
	select {
	case s.register <- registration{p, done}:
	case <-s.done:
		return errRoomStopped
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case <-s.done:
		return errRoomStopped
	case ok := <-done:
		if !ok {
			if s.retirement.Load() != nil {
				return errRoomStopped
			}
			return errServerFull
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

// rejection chooses the close status for a refused admission; retirement wins.
func (s *Server) rejection(err error) (websocket.StatusCode, string) {
	if closure := s.retirement.Load(); closure != nil {
		return closure.code, closure.reason
	}
	if errors.Is(err, errServerFull) {
		return CloseRoomFull, err.Error()
	}
	return websocket.StatusPolicyViolation, err.Error()
}

// runWriter sends deliveries selected by the room owner until the peer ends.
func (s *Server) runWriter(ctx context.Context, p *peer) {
	defer func() {
		if !p.closing.Load() {
			p.cancel()
		}
	}()
	var writing replication.Receipt
	var writingKind replication.Kind
	err := replication.RunWriter(ctx, replication.WriterPort{
		Next: func(c context.Context) (*replication.Packet, error) {
			result := s.deliver(c, deliveryRequest{peer: p})
			if result.packet != nil {
				writing = result.packet.Receipt
				writingKind = result.packet.Kind
			}
			return result.packet, result.err
		},
		Write: func(c context.Context, data []byte) error {
			started := time.Now()
			s.trace.record(p.connection, started, traceSample{Kind: "write_start", Sequence: writing.Sequence, Generation: writing.Generation, Bytes: len(data)})
			kind := websocket.MessageText
			if writingKind == replication.State {
				kind = websocket.MessageBinary
			}
			err := p.conn.Write(c, kind, data)
			s.trace.record(p.connection, time.Now(), traceSample{Kind: "write_end", Sequence: writing.Sequence, Generation: writing.Generation, DurationMS: float64(time.Since(started).Nanoseconds()) / 1e6, Failed: err != nil})
			if err == nil {
				s.mu.Lock()
				s.stats.BytesOut += int64(len(data))
				s.mu.Unlock()
			}
			return err
		},
		Complete: func(c context.Context, receipt replication.Receipt, err error) error {
			return s.deliver(c, deliveryRequest{peer: p, receipt: &receipt, err: err}).err
		},
	})
	_ = err // The owner records delivery failures; cancellation releases the reader.
}

// readMessages forwards validated player messages to the room owner and
// handles in-band session renewal. Returning ends the connection.
func (s *Server) readMessages(ctx context.Context, r *http.Request, p *peer, admitted Identity) {
	for {
		kind, data, err := p.conn.Read(ctx)
		received := time.Now()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.stats.BytesIn += int64(len(data))
		s.mu.Unlock()
		now := time.Now()
		if now.Sub(p.window) >= time.Second {
			p.window = now
			p.messages = 0
		}
		p.messages++
		var auth Authentication
		if json.Unmarshal(data, &auth) == nil && auth.Type == "authenticate" {
			if kind != websocket.MessageText || p.messages > 240 || auth.Version != gameconfig.ProtocolVersion || auth.Proof == "" || auth.Guest != "" || s.admit == nil {
				return
			}
			if !s.renew(ctx, r, p, admitted, auth.Proof) {
				return
			}
			continue
		}
		msg, err := decodeMessage(data)
		if kind != websocket.MessageText || p.messages > 240 || err != nil || msg.Version != gameconfig.ProtocolVersion {
			s.mu.Lock()
			s.stats.Rejected++
			s.mu.Unlock()
			_ = p.conn.Close(websocket.StatusPolicyViolation, "Invalid or excessive messages") //nolint:errcheck // Rejection is followed by unconditional transport cleanup.
			return
		}
		select {
		case s.incoming <- incoming{peer: p, message: msg, received: received}:
		case <-ctx.Done():
			return
		}
	}
}

// renew accepts a fresh proof only for the admitted subject and session.
func (s *Server) renew(ctx context.Context, r *http.Request, p *peer, admitted Identity, proof string) bool {
	var renewed Identity
	err := s.admit(withCredentials(r, proof, ""), func(who Identity) error {
		if who.Subject != admitted.Subject || who.Session != admitted.Session {
			return fmt.Errorf("session_changed")
		}
		renewed = who
		return nil
	})
	if err != nil {
		_ = p.conn.Close(CloseRejected, ReasonAuthenticationExpired) //nolint:errcheck // Deferred cleanup owns the socket.
		return false
	}
	_, err = s.Apply(ctx, Administration{Action: Renew, Session: renewed.Session, Expires: renewed.Expires})
	return err == nil
}

// Player messages are exactly one JSON object with known fields.
func decodeMessage(data []byte) (Message, error) {
	var msg Message
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&msg); err != nil {
		return msg, err
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return msg, fmt.Errorf("trailing JSON")
	}
	return msg, nil
}
