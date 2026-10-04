package main

import (
	"fmt"

	"baboreborn/backend/content"
	"baboreborn/backend/core"
	"baboreborn/backend/gameconfig"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/bots"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/match"
	"baboreborn/backend/server/navigation"
	"baboreborn/backend/server/transport"
)

func configuredRoom(c hosting.Config, arenas []maps.Arena, origins []string, catalog *content.Catalog) (*transport.Server, error) {
	if len(arenas) == 0 || len(arenas) != len(c.Rotation) {
		return nil, fmt.Errorf("rotation not prepared")
	}
	for i, a := range arenas {
		if a.ID != c.Rotation[i] {
			return nil, fmt.Errorf("prepared map differs from selected rotation")
		}
	}
	world, err := match.New(arenas[0])
	if err != nil {
		return nil, err
	}
	world.ConfigureSkins(catalog.SkinIDs(), catalog.DefaultSkin)
	if err := world.ConfigureRotation(arenas, func(g core.Grid) bots.Navigator { return navigation.New(g) }); err != nil {
		return nil, err
	}
	rules := match.DefaultRules()
	rules.Mode = c.Mode
	rules.ScoreLimit = c.ScoreLimit
	rules.TimeLimitTicks = c.TimeLimitMinutes * 60 * gameconfig.TickHz
	rules.RespawnTicks = c.RespawnSeconds * gameconfig.TickHz
	rules.ForceRespawn = c.ForceRespawn
	if err := world.Configure(rules); err != nil {
		return nil, err
	}
	nav := navigation.New(world.Geometry.Grid)
	for i := 0; i < c.Bots; i++ {
		if _, err := world.AddBot(bots.NewSimple(bots.Standard(), uint32(9109+i)), nav); err != nil {
			return nil, err
		}
	}
	room := transport.New(world, c.Capacity, origins)
	room.ContentRevision = catalog.Revision
	room.SetName(c.Name)
	return room, nil
}
