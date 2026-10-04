package identity

import (
	"encoding/json"
	"fmt"

	jose "github.com/go-jose/go-jose/v4"
)

// Registry responses have a distinct purpose and cannot be used as access proofs.
type registryMessage struct {
	Purpose string          `json:"purpose"`
	Issuer  string          `json:"issuer"`
	Nonce   string          `json:"nonce"`
	Payload json.RawMessage `json:"payload"`
}

func (s *Signer) SignRegistry(nonce string, value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(registryMessage{"registry-v1", s.Issuer, nonce, payload})
	if err != nil {
		return "", err
	}
	signed, err := s.signer.Sign(data)
	if err != nil {
		return "", err
	}
	return signed.CompactSerialize()
}
func VerifyRegistry(proof, issuer, nonce string, keys jose.JSONWebKeySet, target any) error {
	signed, err := jose.ParseSigned(proof, []jose.SignatureAlgorithm{jose.RS256})
	if err != nil || len(signed.Signatures) != 1 {
		return fmt.Errorf("invalid_registry_signature")
	}
	matching := keys.Key(signed.Signatures[0].Header.KeyID)
	if len(matching) != 1 {
		return fmt.Errorf("unknown_registry_key")
	}
	if err = ValidateKeys(jose.JSONWebKeySet{Keys: matching}); err != nil {
		return err
	}
	data, err := signed.Verify(matching[0].Key)
	if err != nil {
		return fmt.Errorf("invalid_registry_signature")
	}
	var message registryMessage
	if json.Unmarshal(data, &message) != nil || message.Purpose != "registry-v1" || message.Issuer != issuer || message.Nonce != nonce || nonce == "" {
		return fmt.Errorf("invalid_registry_response")
	}
	return json.Unmarshal(message.Payload, target)
}
