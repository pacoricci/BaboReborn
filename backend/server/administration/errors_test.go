package administration

import (
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestErrorStatusClassifiesByIdentity(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
	}{
		{errOperationPending, http.StatusConflict},
		{fmt.Errorf("rename: %w", errOperationPending), http.StatusConflict},
		{errStorageUnavailable, http.StatusServiceUnavailable},
		{errStorageRead, http.StatusServiceUnavailable},
		{errStorageWrite, http.StatusServiceUnavailable},
		{errStorageCommit, http.StatusServiceUnavailable},
		// Matching text alone must not change the public status.
		{errors.New("storage_unavailable"), http.StatusForbidden},
		{errors.New("admin_required"), http.StatusForbidden},
	} {
		if got := errorStatus(c.err); got != c.status {
			t.Errorf("%v: status %d, want %d", c.err, got, c.status)
		}
	}
}
