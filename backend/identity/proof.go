// Package identity defines the portal identity contract, independent of game and SQL schemas.
package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

const ProofLifetime = 15 * time.Minute
const RenewBefore = 5 * time.Minute
const SessionLifetime = 30 * 24 * time.Hour

type Claims struct {
	jwt.Claims
	Session string `json:"sid"`
}
type Tokens struct {
	Proof     string    `json:"proof"`
	ExpiresAt time.Time `json:"expiresAt"`
}
type Account struct {
	ID string `json:"id"`
}

func Random() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}
func ID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func Hash(s string) []byte      { h := sha256.Sum256([]byte(s)); return h[:] }
func Challenge(s string) string { return base64.RawURLEncoding.EncodeToString(Hash(s)) }
func Equal(a, b string) bool    { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

type Signer struct {
	signer jose.Signer
	Public jose.JSONWebKey
	Issuer string
}

func NewSigner(key *rsa.PrivateKey, kid, issuer string) (*Signer, error) {
	if key == nil || key.N.BitLen() < 2048 || kid == "" || issuer == "" {
		return nil, fmt.Errorf("invalid signing configuration")
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", kid))
	if err != nil {
		return nil, err
	}
	return &Signer{signer: signer, Public: jose.JSONWebKey{Key: &key.PublicKey, KeyID: kid, Algorithm: "RS256", Use: "sig"}, Issuer: issuer}, nil
}
func (s *Signer) Issue(account, server, session string, now, sessionEnd time.Time) (Tokens, error) {
	expires := now.Add(ProofLifetime)
	if sessionEnd.Before(expires) {
		expires = sessionEnd
	}
	if !expires.After(now) {
		return Tokens{}, fmt.Errorf("session expired")
	}
	claims := Claims{Claims: jwt.Claims{Issuer: s.Issuer, Subject: account, Audience: jwt.Audience{server}, IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(expires)}, Session: session}
	proof, err := jwt.Signed(s.signer).Claims(claims).Serialize()
	return Tokens{Proof: proof, ExpiresAt: expires.UTC().Truncate(time.Second)}, err
}
func Verify(proof, issuer, audience string, keys jose.JSONWebKeySet, now time.Time) (Claims, error) {
	var claims Claims
	token, err := jwt.ParseSigned(proof, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil {
		return claims, fmt.Errorf("invalid proof signature")
	}
	if len(token.Headers) != 1 || token.Headers[0].KeyID == "" {
		return claims, fmt.Errorf("missing proof key")
	}
	matching := keys.Key(token.Headers[0].KeyID)
	if len(matching) != 1 {
		return claims, fmt.Errorf("unknown proof key")
	}
	key := matching[0]
	public, ok := key.Key.(*rsa.PublicKey)
	if !ok || public.N.BitLen() < 2048 || key.Algorithm != "RS256" || key.Use != "sig" {
		return claims, fmt.Errorf("invalid proof key")
	}
	if err = token.Claims(public, &claims); err != nil {
		return claims, fmt.Errorf("invalid proof signature")
	}
	if err = claims.ValidateWithLeeway(jwt.Expected{Issuer: issuer, AnyAudience: jwt.Audience{audience}, Time: now}, 0); err != nil {
		return Claims{}, fmt.Errorf("invalid or expired proof")
	}
	if claims.Subject == "" || claims.Session == "" || claims.IssuedAt == nil || claims.Expiry == nil || len(claims.Audience) != 1 || !claims.Expiry.Time().After(now) || claims.Expiry.Time().Sub(claims.IssuedAt.Time()) > ProofLifetime || !claims.Expiry.Time().After(claims.IssuedAt.Time()) {
		return Claims{}, fmt.Errorf("invalid proof claims")
	}
	return claims, nil
}
func LoadSigner(path, kid, issuer string) (*Signer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, fmt.Errorf("invalid PEM private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaKey, ok := key.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("RSA private key required")
	}
	return NewSigner(rsaKey, kid, issuer)
}
func LoadKeys(path string) (jose.JSONWebKeySet, error) {
	var keys jose.JSONWebKeySet
	data, err := os.ReadFile(path)
	if err != nil {
		return keys, err
	}
	err = json.Unmarshal(data, &keys)
	if err != nil {
		return keys, err
	}
	return keys, ValidateKeys(keys)
}
func ValidateKeys(keys jose.JSONWebKeySet) error {
	seen := map[string]bool{}
	for _, key := range keys.Keys {
		public, ok := key.Key.(*rsa.PublicKey)
		if !ok || public.N.BitLen() < 2048 || key.KeyID == "" || seen[key.KeyID] || key.Algorithm != "RS256" || key.Use != "sig" {
			return fmt.Errorf("invalid public key set")
		}
		seen[key.KeyID] = true
	}
	if len(keys.Keys) == 0 {
		return fmt.Errorf("empty public key set")
	}
	return nil
}
