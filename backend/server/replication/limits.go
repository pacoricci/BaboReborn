package replication

import (
	"fmt"
	"time"
)

// Limits bound retained payloads and credit in uncompressed application bytes.
// Control credit is reserved inside, not in addition to, the window.
type Limits struct {
	Peers, FrameBytes, StateBytes                                        int
	JournalBytes, JournalEvents                                          int
	ReliableBytes, ReliableRecords, Controls                             int
	WindowBytes, WindowFrames, ControlReserveBytes, ControlReserveFrames int
	EventBatchBytes, EventBatchRecords, EventBytes, CueBytes, ProbeBytes int
	ReliableAge, StallAge, CueAge, ProbeAge                              time.Duration
}

func DefaultLimits() Limits {
	return Limits{
		Peers: 16, FrameBytes: 2 << 20, StateBytes: 512 << 10,
		JournalBytes: 8 << 20, JournalEvents: 32768,
		ReliableBytes: 6 << 20, ReliableRecords: 16384, Controls: 32,
		WindowBytes: 3 << 20, WindowFrames: 32, ControlReserveBytes: 2 << 20, ControlReserveFrames: 2,
		EventBatchBytes: 64 << 10, EventBatchRecords: 256, EventBytes: 4096, CueBytes: 64 << 10, ProbeBytes: 4096,
		ReliableAge: 5 * time.Second, StallAge: 5 * time.Second, CueAge: 250 * time.Millisecond, ProbeAge: time.Second,
	}
}

func (l Limits) validate() error {
	for _, n := range []int{l.Peers, l.FrameBytes, l.StateBytes, l.JournalBytes, l.JournalEvents, l.ReliableBytes, l.ReliableRecords, l.Controls, l.WindowBytes, l.WindowFrames, l.ControlReserveBytes, l.ControlReserveFrames, l.EventBatchBytes, l.EventBatchRecords, l.EventBytes, l.CueBytes, l.ProbeBytes} {
		if n <= 0 {
			return fmt.Errorf("replication limits must be positive")
		}
	}
	if l.Peers > 16 || l.ControlReserveBytes >= l.WindowBytes || l.ControlReserveFrames >= l.WindowFrames || l.FrameBytes > l.ControlReserveBytes {
		return fmt.Errorf("inconsistent replication capacity or control reserve")
	}
	ordinaryBytes := l.WindowBytes - l.ControlReserveBytes
	if l.StateBytes >= l.FrameBytes || l.StateBytes >= ordinaryBytes || l.CueBytes >= l.FrameBytes || l.CueBytes >= ordinaryBytes || l.ProbeBytes > l.FrameBytes {
		return fmt.Errorf("replaceable payload exceeds transmission capacity")
	}
	if l.EventBatchBytes > l.FrameBytes || l.EventBatchBytes > ordinaryBytes || l.EventBytes >= l.EventBatchBytes || l.JournalBytes < l.EventBytes || l.ReliableBytes < l.FrameBytes {
		return fmt.Errorf("inconsistent required payload limits")
	}
	if l.ReliableAge <= 0 || l.StallAge <= 0 || l.CueAge <= 0 || l.ProbeAge <= 0 {
		return fmt.Errorf("replication ages must be positive")
	}
	return nil
}
