// Package registry defines installation identity independently of browser sessions.
package registry

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

const Heartbeat = 30 * time.Second
const Presence = 90 * time.Second
const PairingLifetime = 15 * time.Minute

type Compatibility struct {
	Publication   int    `json:"publication"`
	API           int    `json:"api"`
	Identity      int    `json:"identity"`
	Protocol      int    `json:"protocol"`
	Profile       string `json:"profile"`
	ContentSchema int    `json:"contentSchema"`
}
type Descriptor struct {
	ID                string     `json:"id"`
	Name              string     `json:"name"`
	Region            string     `json:"region"`
	Origin            string     `json:"origin"`
	CandidateOrigin   string     `json:"candidateOrigin,omitempty"`
	Owner             string     `json:"owner"`
	PublicKey         string     `json:"publicKey"`
	Revision          int64      `json:"revision"`
	AppliedRevision   int64      `json:"appliedRevision"`
	OperationID       string     `json:"operationId"`
	Status            string     `json:"status"`
	Online            bool       `json:"online"`
	Compatible        bool       `json:"compatible"`
	LastSeenAt        *time.Time `json:"lastSeenAt"`
	LastVerifiedAt    *time.Time `json:"lastVerifiedAt"`
	Error             string     `json:"error,omitempty"`
	TransferTo        string     `json:"transferTo,omitempty"`
	TransferExpiresAt *time.Time `json:"transferExpiresAt,omitempty"`
	TransferAccepted  bool       `json:"transferAccepted"`
}
type Request struct {
	Action   string `json:"action"`
	Nonce    string `json:"nonce"`
	ServerID string `json:"serverId,omitempty"`
	Code     string `json:"code,omitempty"`
	Revision int64  `json:"revision,omitempty"`
}
type NonceRequest struct {
	Purpose   string `json:"purpose"`
	ServerID  string `json:"serverId,omitempty"`
	Code      string `json:"code,omitempty"`
	RequestID string `json:"requestId"`
}
type Packet struct {
	Key       string `json:"key"`
	Body      string `json:"body"`
	Signature string `json:"signature"`
}
type Probe struct {
	Release       string        `json:"release,omitempty"`
	Nonce         string        `json:"nonce"`
	Compatibility Compatibility `json:"compatibility"`
}

func Public(key ed25519.PrivateKey) string {
	return base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
}
func Key(value string) (ed25519.PublicKey, error) {
	key, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid_public_key")
	}
	return ed25519.PublicKey(key), nil
}
func Sign(key ed25519.PrivateKey, value any) (Packet, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return Packet{}, err
	}
	return Packet{Public(key), base64.RawURLEncoding.EncodeToString(b), base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, b))}, nil
}
func (p Packet) Verify(target any) error {
	return p.VerifyLimit(target, 8192)
}

// Publication snapshots have a separate budget; probe and identity limits stay small.
func (p Packet) VerifyLimit(target any, limit int) error {
	key, err := Key(p.Key)
	if err != nil {
		return err
	}
	b, err := base64.RawURLEncoding.DecodeString(p.Body)
	if err != nil || len(b) > limit {
		return fmt.Errorf("invalid_signed_body")
	}
	sig, err := base64.RawURLEncoding.DecodeString(p.Signature)
	if err != nil || !ed25519.Verify(key, b, sig) {
		return fmt.Errorf("invalid_signature")
	}
	return json.Unmarshal(b, target)
}
