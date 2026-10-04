// Package testwire provides an independent generated reader for socket tests.
package testwire

import "encoding/json"

func Expand(data []byte) ([]byte, error) {
	if json.Valid(data) {
		return data, nil
	}
	return Delivery(data)
}
func Unmarshal(data []byte, value any) error {
	b, err := Expand(data)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, value)
}
