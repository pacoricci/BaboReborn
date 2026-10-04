package transport

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRetireClosesAdmissionWhenCallerCancelsBeforeAck(t *testing.T) {
	s := &Server{administration: make(chan administrativeRequest), done: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	completed := make(chan error, 1)
	go func() {
		_, err := s.Apply(ctx, Administration{Action: Retire, Code: CloseRoomClosed, Reason: ReasonRoomClosed})
		completed <- err
	}()
	var request administrativeRequest
	select {
	case request = <-s.administration:
	case <-time.After(time.Second):
		t.Fatal("retirement was not queued")
	}
	cancel()
	select {
	case err := <-completed:
		if !errors.Is(err, context.Canceled) || !s.Retiring() {
			t.Fatalf("delivered retirement lost after cancellation: %v, retiring=%v", err, s.Retiring())
		}
	case <-time.After(time.Second):
		t.Fatal("retirement ignored caller cancellation while owner was stalled")
	}
	request.done <- []Participant{{ID: 42}}
}

func TestCancelledRetireBeforeDeliveryKeepsAdmissionOpen(t *testing.T) {
	s := &Server{administration: make(chan administrativeRequest), done: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := s.Apply(ctx, Administration{Action: Retire, Code: CloseRoomClosed, Reason: ReasonRoomClosed})
	if !errors.Is(err, context.Canceled) || s.Retiring() {
		t.Fatalf("undelivered retirement changed admission: %v, retiring=%v", err, s.Retiring())
	}
}
