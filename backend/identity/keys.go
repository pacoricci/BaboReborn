package identity

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	jose "github.com/go-jose/go-jose/v4"
)

// GenerateKey publishes the new public key alongside all previous keys. Operators
// keep signing with the old key until servers have fetched the expanded key set.
func GenerateKey(privatePath, publicPath, kid string) error {
	if kid == "" {
		return fmt.Errorf("key ID required")
	}
	keys := jose.JSONWebKeySet{}
	if _, err := os.Stat(publicPath); err == nil {
		var err error
		keys, err = LoadKeys(publicPath)
		if err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if len(keys.Key(kid)) != 0 {
		return fmt.Errorf("key ID already exists")
	}
	key, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return err
	}
	signer, err := NewSigner(key, kid, "key-generation")
	if err != nil {
		return err
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(privatePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private}))
	if err = errors.Join(writeErr, f.Sync(), f.Close()); err != nil {
		return err
	}
	keys.Keys = append(keys.Keys, signer.Public)
	data, err := json.Marshal(keys)
	if err != nil {
		return err
	}
	return SaveKeys(publicPath, data)
}
func SaveKeys(path string, data []byte) (err error) {
	f, err := os.CreateTemp(filepath.Dir(path), ".keys-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() {
		if e := os.Remove(name); e != nil && !os.IsNotExist(e) {
			err = errors.Join(err, e)
		}
	}()
	_, writeErr := f.Write(data)
	if err = errors.Join(writeErr, f.Sync(), f.Close()); err != nil {
		return err
	}
	return os.Rename(name, path)
}
