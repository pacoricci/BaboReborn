// Package replication owns bounded delivery policy, independently of socket I/O.
// A room has one caller/owner. Only RunWriter runs outside that owner; its Next
// and Complete callbacks must hand work back to the owner, not share mutable state.
package replication

import (
	"encoding/json"
	"errors"
	"time"

	"baboreborn/backend/server/wire"
)

type Kind string

const (
	Installation Kind = "installation"
	Control      Kind = "control"
	State        Kind = "state"
	Events       Kind = "events"
	Cues         Kind = "cues"
	Probe        Kind = "probe"
)

type Reason string

const (
	ReliableTimeout  Reason = "reliable_delivery_timeout"
	DeliveryStalled  Reason = "delivery_stalled"
	BacklogExceeded  Reason = "reliable_backlog_exceeded"
	InvalidReceipt   Reason = "invalid_receipt"
	WriteFailed      Reason = "write_failed"
	EncodingFailed   Reason = "encoding_failed"
	ProducerOverload Reason = "replication_producer_overload"
)

var (
	ErrPublication         = errors.New("invalid replication publication")
	ErrProducerLimit       = errors.New("replication producer limit exceeded")
	ErrInstallationPending = errors.New("installation still awaiting receipt")
	ErrPeer                = errors.New("unknown or closed replication peer")
)

// Envelope is encoded by the protocol adapter before transmission.
// The adapter encodes it before credit is committed, so accounting includes the
// envelope headers before transport compression. State bodies are Protobuf;
// other bodies are JSON. Body and returned packet
// bytes must be treated as immutable.
type Envelope struct {
	Connection   string `json:"connection"`
	Sequence     int    `json:"sequence"`
	Generation   int    `json:"generation"`
	EventThrough int    `json:"eventThrough"`
	SentAtMS     int64  `json:"sentAtMs"`
	Kind         Kind   `json:"kind"`
	Body         []byte `json:"-"`
}

// Encoder returns detached bytes that remain unchanged across subsequent calls.
type Encoder func(Envelope) ([]byte, error)
type Receipt struct {
	Connection   string `json:"connection"`
	Sequence     int    `json:"sequence"`
	Generation   int    `json:"generation"`
	EventThrough int    `json:"eventThrough"`
}
type Packet struct {
	Receipt  Receipt
	Kind     Kind
	Data     []byte
	Deadline time.Time
}

// Baseline.Body must contain the complete installation, including State. The
// adapter captures both atomically on the authority owner before calling Install.
type Baseline struct {
	State wire.Snapshot
	Body  json.RawMessage
}

type Usage struct {
	RateHz                                                                                      int
	PendingState, PendingCues                                                                   bool
	ReliableBytes, ReliableRecords, Controls, OutstandingBytes, OutstandingFrames, WritingBytes int
	EventThrough, Sequence, Generation                                                          int
	ReplacedStates, DroppedCues                                                                 int
	Closed                                                                                      Reason
}
type RoomUsage struct{ JournalBytes, JournalEvents, Peers int }

const maxSequence = 1<<53 - 1
