package gameconfig

// Authority clock shared by simulation, replication and parity tools. The browser
// mirrors it in frontend/src/core/timing.ts and checks it during the handshake.
const (
	TickHz      = 120         // [Hz]
	TickSeconds = 1. / TickHz // [s]
)
