package replication

import (
	"context"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"baboreborn/backend/internal/testwire"
)

func TestWriterAsksOwnerForLatestStateAfterBlockedWrite(t *testing.T) {
	f := setup(t, nil)
	f.now = time.Now()
	f.join(1)
	f.publish(1, 0, 1)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requests := make(chan chan *Packet)
	started := make(chan []byte)
	release := make(chan struct{})
	type completion struct {
		receipt Receipt
		err     error
	}
	completed := make(chan completion, 1)
	done := make(chan error, 1)
	var active, peak atomic.Int32
	go func() {
		done <- RunWriter(ctx, WriterPort{
			Next: func(ctx context.Context) (*Packet, error) {
				reply := make(chan *Packet)
				select {
				case requests <- reply:
				case <-ctx.Done():
					return nil, ctx.Err()
				}
				select {
				case p := <-reply:
					return p, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			},
			Write: func(ctx context.Context, data []byte) error {
				n := active.Add(1)
				if n > peak.Load() {
					peak.Store(n)
				}
				defer active.Add(-1)
				select {
				case started <- data:
				case <-ctx.Done():
					return ctx.Err()
				}
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			},
			Complete: func(_ context.Context, a Receipt, err error) error { completed <- completion{a, err}; return err },
		})
	}()
	request := <-requests
	first := f.take(1, State)
	request <- first
	<-started
	for tick := 2; tick <= 16; tick++ {
		f.publish(tick, 0, 1)
	}
	select {
	case <-requests:
		t.Fatal("writer preselected more state while blocked")
	default:
	}
	release <- struct{}{}
	c := <-completed
	if err := f.room.Written(1, c.receipt, c.err); err != nil {
		t.Fatal(err)
	}
	request = <-requests
	latest := f.take(1, State)
	request <- latest
	data := <-started
	var envelope struct {
		Body json.RawMessage `json:"body"`
	}
	if err := testwire.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Tick int `json:"tick"`
	}
	if err := json.Unmarshal(envelope.Body, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Tick != 16 || peak.Load() != 1 {
		t.Fatal(snapshot, peak.Load())
	}
	cancel()
	c = <-completed
	if !errors.Is(c.err, context.Canceled) {
		t.Fatal(c.err)
	}
	if err := f.room.Written(1, c.receipt, c.err); !errors.Is(err, ErrPeer) {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if u := f.usage(1); u.Closed != WriteFailed || u.WritingBytes != 0 {
		t.Fatal(u)
	}
}

func TestWriterDeadlineIsTerminalAndNeverRetried(t *testing.T) {
	calls, completions := 0, 0
	err := RunWriter(context.Background(), WriterPort{
		Next: func(context.Context) (*Packet, error) {
			calls++
			return &Packet{Deadline: time.Now().Add(-time.Second)}, nil
		},
		Write: func(ctx context.Context, _ []byte) error { return ctx.Err() },
		Complete: func(_ context.Context, _ Receipt, err error) error {
			completions++
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			return nil
		},
	})
	if !errors.Is(err, context.DeadlineExceeded) || calls != 1 || completions != 1 {
		t.Fatal(err, calls, completions)
	}
}
