package registration

import (
	"context"
	"fmt"
	"log"
	"time"

	"baboreborn/backend/registry"
)

func (c *Client) Publish(ctx context.Context) error {
	if c.Publication == nil {
		return nil
	}
	c.mu.RLock()
	key, d := c.key, c.current
	c.mu.RUnlock()
	if d.ID == "" || d.Status != "active" || d.PublicKey != registry.Public(key) {
		return nil
	}
	nonce, err := c.nonce(ctx, key, registry.NonceRequest{Purpose: "publication", ServerID: d.ID})
	if err != nil {
		return err
	}
	// Sample after obtaining the nonce: its central timestamp orders snapshots across restarts.
	p, err := c.Publication(ctx)
	if err != nil {
		return err
	}
	p.Schema, p.ServerID, p.Revision, p.Nonce = registry.PublicationSchemaVersion, d.ID, d.Revision, nonce
	if err = p.Validate(); err != nil {
		return err
	}
	packet, err := registry.Sign(key, p)
	if err != nil {
		return err
	}
	var result struct {
		Published bool `json:"published"`
	}
	if err = c.post(ctx, "/registry/v1/publication", packet, &result); err != nil {
		return err
	}
	if !result.Published {
		return fmt.Errorf("invalid_publication_response")
	}
	return nil
}
func (c *Client) runPublisher(ctx context.Context) {
	delay := registry.PublicationInterval
	for ctx.Err() == nil {
		if err := c.Publish(ctx); err != nil {
			log.Printf("Room publication: %v", err)
			delay = min(delay*2, time.Minute)
		} else {
			delay = registry.PublicationInterval
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-c.publicationWake:
			timer.Stop()
		case <-timer.C:
		}
	}
}
