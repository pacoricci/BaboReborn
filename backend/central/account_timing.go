package central

import "time"

const accountDeletionTimeout = 10 * time.Second

// The stored OIDC flow and its browser cookie expire together.
const loginFlowLifetime = 10 * time.Minute
