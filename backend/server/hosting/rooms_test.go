package hosting

import (
	"context"
	"testing"

	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/transport"
)

func TestPersistentRoomInstancesHaveNoDefaultOrExpiry(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	arena, err := maps.Parse(testcontent.Map("yard"))
	if err != nil {
		t.Fatal(err)
	}
	m := New(ctx, []MapInfo{{ID: arena.ID, Name: arena.Name, CTF: arena.Teams != nil}}, func(_ context.Context, c Config) (*transport.Server, error) {
		return transport.New(match.MustNew(testcontent.Map("yard")), c.Capacity, nil), nil
	}, 1)
	if len(m.Directory().Rooms) != 0 {
		t.Fatal("automatic default room")
	}
	config := Config{Name: "Room", Mode: "dm", Capacity: 2, Rotation: []string{"yard"}}
	s, err := m.Prepare(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Install("one", s); err != nil {
		t.Fatal(err)
	}
	extra, err := m.Prepare(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Install("two", extra); err == nil {
		t.Fatal("total room cap ignored")
	}
	if err := m.Remove(ctx, "one", false); err != nil {
		t.Fatal(err)
	}
	if len(m.Directory().Rooms) != 0 {
		t.Fatal("closed room retained")
	}
	if err := m.Install("two", extra); err != nil {
		t.Fatal(err)
	}
}
func TestRoomConfigurationConstraints(t *testing.T) {
	arena, err := maps.Parse(testcontent.Map("yard"))
	if err != nil {
		t.Fatal(err)
	}
	// Use a DM-only catalog fixture regardless of bundled maps gaining team support.
	m := New(context.Background(), []MapInfo{{ID: arena.ID, Name: arena.Name, CTF: false}}, nil, 8)
	good := Config{Name: "Room", Mode: "dm", Capacity: 2, Rotation: []string{"yard"}}
	if err := m.Validate(good); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Config){func(c *Config) { c.Capacity = 17 }, func(c *Config) { c.Name = "" }, func(c *Config) { c.Bots = 2 }, func(c *Config) { c.Mode = "ctf" }, func(c *Config) { c.Rotation = nil }, func(c *Config) { c.TimeLimitMinutes = 181 }} {
		bad := good
		change(&bad)
		if err := m.Validate(bad); err == nil {
			t.Fatal("invalid configuration accepted", bad)
		}
	}
}
