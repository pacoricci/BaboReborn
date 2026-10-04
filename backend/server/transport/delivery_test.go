package transport

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"baboreborn/backend/gameconfig"
	"baboreborn/backend/internal/testwire"
	"baboreborn/backend/server/replication"
	"baboreborn/backend/server/wire"
)

var testConnections sync.Map

// Socket tests can observe required batches alongside their last installed state.
type receivedSnapshot struct {
	wire.Snapshot
	Delivery wire.EventBatch
}

// Each test socket has one reader; writers only consult the atomic generation.
type testConnection struct {
	mu         sync.Mutex
	generation int
	state      wire.Snapshot
}

func testClient(c *websocket.Conn) *testConnection {
	v, _ := testConnections.LoadOrStore(c, &testConnection{})
	return v.(*testConnection)
}
func readMessage(ctx context.Context, c *websocket.Conn, value any) error {
	_, raw, readErr := c.Read(ctx)
	if err := readErr; err != nil {
		return err
	}
	expanded, err := testwire.Expand(raw)
	if err != nil {
		return err
	}
	raw = expanded
	var f struct {
		Type string
		replication.Envelope
		Body json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return err
	}
	if f.Type != "delivery" {
		return json.Unmarshal(raw, value)
	} // Discovery has no replica slot.
	client := testClient(c)
	client.mu.Lock()
	client.generation = f.Generation
	if f.Kind == replication.State {
		before := client.state
		next := before
		next.Players = nil // Membership/order can change; never reuse metadata by array index.
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(f.Body, &fields); err != nil {
			client.mu.Unlock()
			return err
		}
		items, projectiles := fields["items"], fields["projectiles"]
		delete(fields, "items")
		delete(fields, "projectiles")
		body, err := json.Marshal(fields)
		if err != nil {
			client.mu.Unlock()
			return err
		}
		if err = json.Unmarshal(body, &next); err != nil {
			client.mu.Unlock()
			return err
		}
		next.Items, err = restoreTestEntities(items, before.Items, func(v wire.Item) int { return v.ID })
		if err != nil {
			client.mu.Unlock()
			return err
		}
		next.Projectiles, err = restoreTestEntities(projectiles, before.Projectiles, func(v wire.Projectile) int { return v.ID })
		if err != nil {
			client.mu.Unlock()
			return err
		}
		var presence struct{ Players []struct{ Team *string } }
		if err := json.Unmarshal(f.Body, &presence); err != nil {
			client.mu.Unlock()
			return err
		}
		for i := range next.Players {
			if presence.Players[i].Team != nil {
				continue
			}
			for _, old := range before.Players {
				if old.ID == next.Players[i].ID {
					next.Players[i].Team, next.Players[i].Nickname, next.Players[i].Appearance = old.Team, old.Nickname, old.Appearance
					break
				}
			}
		}
		client.state = next
	}
	if f.Kind == replication.Installation {
		var body struct{ State wire.Snapshot }
		if err := json.Unmarshal(f.Body, &body); err != nil {
			client.mu.Unlock()
			return err
		}
		client.state = body.State
	}
	err = nil
	if target, ok := value.(*receivedSnapshot); ok {
		*target = receivedSnapshot{}
		switch f.Kind {
		case replication.Events, replication.Cues:
			target.Snapshot = client.state
			err = json.Unmarshal(f.Body, &target.Delivery)
		case replication.State:
			target.Snapshot = client.state
		default:
			err = json.Unmarshal(f.Body, &target.Snapshot)
		}
	} else {
		err = json.Unmarshal(f.Body, value)
	}
	client.mu.Unlock()
	if err != nil {
		return err
	}
	return wsjson.Write(ctx, c, Message{Type: "receipt", Version: gameconfig.ProtocolVersion, Receipt: &replication.Receipt{Connection: f.Connection, Sequence: f.Sequence, Generation: f.Generation, EventThrough: f.EventThrough}})
}
func writeMessage(ctx context.Context, c *websocket.Conn, value any) error {
	if m, ok := value.(Message); ok {
		client := testClient(c)
		client.mu.Lock()
		m.Generation = client.generation
		client.mu.Unlock()
		value = m
	}
	return wsjson.Write(ctx, c, value)
}

func restoreTestEntities[T any](raw json.RawMessage, before []T, id func(T) int) ([]T, error) {
	if len(raw) == 0 {
		return before, nil
	}
	var delta struct {
		Upsert []T
		Remove []int
	}
	if err := json.Unmarshal(raw, &delta); err != nil {
		return nil, err
	}
	out := append([]T{}, before...)
	for _, key := range delta.Remove {
		for i, v := range out {
			if id(v) == key {
				out = append(out[:i], out[i+1:]...)
				break
			}
		}
	}
	for _, v := range delta.Upsert {
		found := false
		for i, old := range out {
			if id(old) == id(v) {
				out[i] = v
				found = true
				break
			}
		}
		if !found {
			out = append(out, v)
		}
	}
	return out, nil
}
