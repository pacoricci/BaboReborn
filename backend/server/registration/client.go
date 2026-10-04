// Package registration owns the durable installation identity and registry transport.
package registration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	mathrand "math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
	"baboreborn/backend/release"
)

type Client struct {
	publicationWake chan struct{}
	Publication     func(context.Context) (registry.Publication, error)
	mu              sync.RWMutex
	DB              *sql.DB
	Central         string
	Development     bool
	Compatibility   registry.Compatibility
	Release         string
	HTTP            *http.Client
	Verify          func(string, string, any) error
	Apply           func(context.Context, registry.Descriptor, ed25519.PrivateKey) error
	current         registry.Descriptor
	key             ed25519.PrivateKey
	pending         ed25519.PrivateKey
	code            string
}

func Open(ctx context.Context, db *sql.DB, central, codeFile string, development bool, compatibility registry.Compatibility) (*Client, error) {
	canonical, err := identity.CanonicalOrigin(central, development)
	if err != nil {
		return nil, fmt.Errorf("valid central origin required")
	}
	central = canonical
	c := &Client{DB: db, Central: strings.TrimRight(central, "/"), Development: development, Compatibility: compatibility, Release: release.Version, HTTP: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
	var previousCentral, raw, lastHash string
	var privateKey, pendingKey []byte
	err = db.QueryRowContext(ctx, "SELECT central,private_key,pending_key,pairing_code,descriptor,last_pairing_hash FROM association WHERE singleton=1").Scan(&previousCentral, &privateKey, &pendingKey, &c.code, &raw, &lastHash)
	switch err {
	case sql.ErrNoRows:
		var key ed25519.PrivateKey
		if _, key, err = ed25519.GenerateKey(rand.Reader); err != nil {
			return nil, err
		}
		c.key = key
		_, err = db.ExecContext(ctx, "INSERT INTO association(singleton,central,private_key) VALUES(1,$1,$2)", c.Central, []byte(key))
	case nil:
		c.key = ed25519.PrivateKey(privateKey)
		c.pending = ed25519.PrivateKey(pendingKey)
		if previousCentral != c.Central {
			return nil, fmt.Errorf("association belongs to a different central origin")
		}
		if err = json.Unmarshal([]byte(raw), &c.current); err != nil {
			return nil, err
		}
	}
	if err != nil {
		return nil, err
	}
	if len(c.key) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("invalid installation key")
	}
	if codeFile != "" {
		f, err := os.Open(codeFile)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(f, 1025))
		closeErr := f.Close()
		if err != nil || closeErr != nil {
			return nil, fmt.Errorf("cannot read pairing code")
		}
		code := strings.TrimSpace(string(data))
		if len(code) != 43 {
			return nil, fmt.Errorf("invalid pairing code file")
		}
		if identity.Challenge(code) != lastHash {
			_, key, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				return nil, err
			}
			c.pending = key
			c.code = code
			_, err = db.ExecContext(ctx, "UPDATE association SET pending_key=$1,pairing_code=$2,last_pairing_hash=$3 WHERE singleton=1", []byte(key), code, identity.Challenge(code))
			if err != nil {
				return nil, err
			}
		}
	}
	return c, nil
}
func (c *Client) Snapshot() registry.Descriptor { c.mu.RLock(); defer c.mu.RUnlock(); return c.current }
func (c *Client) post(ctx context.Context, path string, input, out any) error {
	b, err := json.Marshal(input)
	if err != nil {
		return err
	}
	r, err := http.NewRequestWithContext(ctx, "POST", c.Central+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	r.Header.Set("Content-Type", "application/json")
	response, err := c.HTTP.Do(r)
	if err != nil {
		return fmt.Errorf("central_unreachable")
	}
	defer response.Body.Close() //nolint:errcheck // Response decoding determines success.
	b, err = io.ReadAll(io.LimitReader(response.Body, 32769))
	if err != nil || len(b) > 32768 {
		return fmt.Errorf("invalid_registry_response")
	}
	if response.StatusCode != http.StatusOK {
		var problem struct {
			Error       string `json:"error"`
			Recoverable *bool  `json:"recoverable"`
		}
		if json.Unmarshal(b, &problem) != nil || problem.Error == "" {
			return &OperationError{Code: fmt.Sprintf("registry_http_%d", response.StatusCode), Recoverable: retryableHTTP(response.StatusCode)}
		}
		recoverable := retryableHTTP(response.StatusCode)
		if problem.Recoverable != nil {
			recoverable = *problem.Recoverable
		}
		return &OperationError{Code: problem.Error, Recoverable: recoverable}
	}
	return json.Unmarshal(b, out)
}
func (c *Client) request(ctx context.Context, key ed25519.PrivateKey, request registry.Request) (registry.Descriptor, error) {
	var d registry.Descriptor
	nonce, err := c.nonce(ctx, key, registry.NonceRequest{Purpose: request.Action, ServerID: request.ServerID, Code: request.Code})
	if err != nil {
		return d, err
	}
	request.Nonce = nonce
	p, err := registry.Sign(key, request)
	if err != nil {
		return d, err
	}
	var result struct {
		Response string `json:"response"`
	}
	err = c.post(ctx, "/registry/v1/request", p, &result)
	if err != nil {
		return d, err
	}
	if c.Verify == nil {
		return d, fmt.Errorf("registry_verification_unavailable")
	}
	err = c.Verify(result.Response, request.Nonce, &d)
	return d, err
}

func (c *Client) nonce(ctx context.Context, key ed25519.PrivateKey, request registry.NonceRequest) (string, error) {
	request.RequestID = identity.ID()
	packet, err := registry.Sign(key, request)
	if err != nil {
		return "", err
	}
	var result struct {
		Nonce string `json:"nonce"`
	}
	if err = c.post(ctx, "/registry/v1/nonce", packet, &result); err != nil {
		return "", err
	}
	if result.Nonce == "" {
		return "", fmt.Errorf("invalid_registry_response")
	}
	return result.Nonce, nil
}
func (c *Client) Step(ctx context.Context) error {
	c.mu.RLock()
	key := c.key
	code := c.code
	current := c.current
	if code != "" {
		key = c.pending
	}
	c.mu.RUnlock()
	if code == "" && current.ID == "" {
		return &OperationError{Code: "pairing_code_required"}
	}
	if code == "" && current.Status == "removed" {
		return &OperationError{Code: "installation_revoked"}
	}
	request := registry.Request{Action: "heartbeat", ServerID: current.ID}
	if code != "" {
		request.Action = "claim"
		request.Code = code
	}
	d, err := c.request(ctx, key, request)
	if err != nil {
		var problem *OperationError
		if errors.As(err, &problem) && (problem.Code == "installation_revoked" || problem.Code == "server_removed") {
			current.Status = "removed"
			if c.Apply != nil {
				if err := c.Apply(ctx, current, key); err != nil {
					return err
				}
			}
			c.mu.Lock()
			c.current = current
			c.mu.Unlock()
			if problem.Code == "server_removed" {
				return nil
			}
		}
		return err
	}
	if d.ID == "" || d.Revision < current.Revision || d.PublicKey != registry.Public(key) && d.Status != "removed" {
		return fmt.Errorf("invalid_association_response")
	}
	if c.Apply == nil {
		return fmt.Errorf("association_application_unavailable")
	}
	if err = c.Apply(ctx, d, key); err != nil {
		return err
	}
	c.mu.Lock()
	c.current = d
	c.key = key
	c.pending = nil
	c.code = ""
	c.mu.Unlock()
	if d.Status == "removed" {
		return nil
	}
	ack, err := c.request(ctx, key, registry.Request{Action: "ack", ServerID: d.ID, Revision: d.Revision})
	if err == nil {
		c.mu.Lock()
		c.current = ack
		c.mu.Unlock()
		select {
		case c.publicationWake <- struct{}{}:
		default:
		}
	}
	return err
}

// OperationError retains the central's retry decision independently of its message.
type OperationError struct {
	Code        string
	Recoverable bool
}

func (e *OperationError) Error() string { return e.Code }

func retryableHTTP(status int) bool {
	// Non-registry responses (for example a proxy) have no recoverable field.
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500
}

func intervention(code string) string {
	switch code {
	case "invalid_pairing_code", "pairing_code_required":
		return "generate a new pairing code in the central portal, replace the pairing code file and restart the server"
	case "installation_revoked", "server_not_found":
		return "register or pair this installation again in the central portal with a new pairing code, then restart the server"
	default:
		return "check the central configuration and server compatibility, correct the reported error and restart the server"
	}
}

func waitRetry(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return ctx.Err() == nil
	}
}

func (c *Client) Run(ctx context.Context) {
	runCtx, cancel := context.WithCancel(ctx)
	c.publicationWake = make(chan struct{}, 1)
	publisherDone := make(chan struct{})
	go func() {
		defer close(publisherDone)
		c.runPublisher(runCtx)
	}()
	c.run(runCtx, waitRetry, mathrand.Float64)
	cancel()
	<-publisherDone
}

func (c *Client) run(ctx context.Context, wait func(context.Context, time.Duration) bool, random func() float64) {
	const initial = 5 * time.Second
	const maximum = 2 * time.Minute
	backoff := initial
	for ctx.Err() == nil {
		err := c.Step(ctx)
		if ctx.Err() != nil {
			return
		}
		delay := registry.Heartbeat
		if err != nil {
			var problem *OperationError
			if errors.As(err, &problem) && !problem.Recoverable {
				log.Printf("Registry stopped: %v; intervention required: %s", err, intervention(problem.Code))
				return
			}
			// Equal jitter prevents synchronized retries while keeping a nonzero floor.
			delay = backoff/2 + time.Duration(random()*float64(backoff/2))
			log.Printf("Registry: %v; retry in %s", err, delay)
			backoff = min(backoff*2, maximum)
		} else {
			backoff = initial
			if c.Snapshot().Status == "removed" {
				log.Printf("Registry stopped: installation removed; intervention required: %s", intervention("installation_revoked"))
				return
			}
		}
		if !wait(ctx, delay) {
			return
		}
	}
}
func (c *Client) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probe := r.URL.Path == "/registry/v1/probe" || r.URL.Path == "/ws" && r.URL.Query().Has("probe")
		if !probe {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != "GET" {
			identity.Error(w, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		nonce := r.URL.Query().Get("nonce")
		if len(nonce) != 43 {
			identity.Error(w, http.StatusBadRequest, "invalid_challenge")
			return
		}
		c.mu.RLock()
		key := c.key
		if len(c.pending) != 0 && registry.Public(c.pending) == r.URL.Query().Get("key") {
			key = c.pending
		}
		c.mu.RUnlock()
		if registry.Public(key) != r.URL.Query().Get("key") {
			identity.Error(w, http.StatusNotFound, "installation_not_found")
			return
		}
		packet, err := registry.Sign(key, registry.Probe{Nonce: nonce, Compatibility: c.Compatibility, Release: c.Release})
		if err != nil {
			identity.Error(w, http.StatusInternalServerError, "signing_failed")
			return
		}
		if r.URL.Path != "/ws" {
			identity.JSON(w, http.StatusOK, packet)
			return
		}
		if !identity.SameOrigin(r, c.Central) {
			identity.Error(w, http.StatusForbidden, "origin_refused")
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow() //nolint:errcheck // Probe cleanup.
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		b, err := json.Marshal(packet)
		if err == nil {
			_ = conn.Write(ctx, websocket.MessageText, b) //nolint:errcheck // Probe ends after this bounded write.
		}
	})
}
