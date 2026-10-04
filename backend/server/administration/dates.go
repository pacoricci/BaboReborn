package administration

import (
	"encoding/json"
	"time"
)

// SQLite keeps Unix seconds; HTTP dates use the same UTC representation as central.
func optionalDate(seconds *int64) *time.Time {
	if seconds == nil {
		return nil
	}
	date := time.Unix(*seconds, 0).UTC()
	return &date
}

// Audit details retain their stored JSON; only sanction expiry is an HTTP date.
func eventDetails(action, raw string) (json.RawMessage, error) {
	if action != "sanction" {
		return json.RawMessage(raw), nil
	}
	var details map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &details); err != nil {
		return nil, err
	}
	value, ok := details["expiresAt"]
	if !ok {
		return json.RawMessage(raw), nil
	}
	var expires *int64
	if err := json.Unmarshal(value, &expires); err != nil {
		return nil, err
	}
	date, err := json.Marshal(optionalDate(expires))
	if err != nil {
		return nil, err
	}
	details["expiresAt"] = date
	return json.Marshal(details)
}
