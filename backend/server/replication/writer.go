package replication

import (
	"context"
	"fmt"
)

type WriterPort struct {
	// Next waits for a packet selected by the room owner, or context cancellation.
	Next     func(context.Context) (*Packet, error)
	Write    func(context.Context, []byte) error
	Complete func(context.Context, Receipt, error) error
}

// RunWriter issues exactly one write at a time and asks for the next packet only
// after reporting completion. Cancellation must also cancel the transport write.
// Do not retry on a write deadline: the WebSocket connection is no longer usable.
func RunWriter(ctx context.Context, port WriterPort) error {
	if port.Next == nil || port.Write == nil || port.Complete == nil {
		return fmt.Errorf("incomplete replication writer port")
	}
	for {
		packet, err := port.Next(ctx)
		if err != nil {
			return err
		}
		if packet == nil {
			return fmt.Errorf("writer received no packet")
		}
		writeCtx, cancel := context.WithDeadline(ctx, packet.Deadline)
		err = port.Write(writeCtx, packet.Data)
		cancel()
		completionErr := port.Complete(ctx, packet.Receipt, err)
		if err != nil {
			return err
		}
		if completionErr != nil {
			return completionErr
		}
	}
}
