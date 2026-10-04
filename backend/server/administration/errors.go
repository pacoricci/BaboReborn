package administration

import (
	"errors"
	"net/http"
)

// Error text is the public API code; status classification uses identity, not text.
var (
	errOperationPending   = errors.New("room_operation_pending")
	errStorageUnavailable = errors.New("storage_unavailable")
	errStorageRead        = errors.New("storage_read_failed")
	errStorageWrite       = errors.New("storage_write_failed")
	errStorageCommit      = errors.New("storage_commit_failed")
)

// Unclassified operation errors are authorization or validation refusals.
func errorStatus(err error) int {
	switch {
	case errors.Is(err, errOperationPending):
		return http.StatusConflict
	case errors.Is(err, errStorageUnavailable), errors.Is(err, errStorageRead),
		errors.Is(err, errStorageWrite), errors.Is(err, errStorageCommit):
		return http.StatusServiceUnavailable
	default:
		return http.StatusForbidden
	}
}
