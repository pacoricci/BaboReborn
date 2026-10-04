package match

import (
	"fmt"

	"baboreborn/backend/core"
	"baboreborn/backend/maps"
	"baboreborn/backend/server/bots"
)

type preparedMap struct {
	arena      Arena
	geometry   core.World
	navigation bots.Navigator
}

// ConfigureRotation runs before the owner starts. Navigation is supplied by composition,
// so the Deathmatch lifecycle does not import a concrete routing implementation.
func (w *World) ConfigureRotation(arenas []maps.Arena, navigator func(core.Grid) bots.Navigator) error {
	if w.Tick != 0 || len(w.Players) != 0 {
		return fmt.Errorf("configure rotation before adding players")
	}
	if len(arenas) == 0 {
		return fmt.Errorf("rotation must contain a map")
	}
	prepared := make([]preparedMap, 0, len(arenas))
	for _, a := range arenas {
		a, err := ownArena(a)
		if err != nil {
			return err
		}
		if w.Rules.Mode == ModeCTF && a.Teams == nil {
			return fmt.Errorf("CTF requires team map %q", a.ID)
		}
		geometry := core.World{Walls: a.GeometryWalls(), Grid: core.NewGrid(core.Wall{W: a.Width, H: a.Height}, a.GeometryWalls())}
		var nav bots.Navigator
		if navigator != nil {
			nav = navigator(geometry.Grid)
			if nav == nil {
				return fmt.Errorf("navigator factory returned nil for map %q", a.ID)
			}
		}
		prepared = append(prepared, preparedMap{a, geometry, nav})
	}
	w.rotation = prepared
	w.activateMap(0)
	return nil
}

// Rooms share prepared arenas, so each world validates and keeps its own slices.
func ownArena(a maps.Arena) (maps.Arena, error) {
	if err := a.Validate(); err != nil {
		return maps.Arena{}, err
	}
	a.Walls = append([]maps.Wall{}, a.Walls...)
	if a.Decals != nil {
		a.Decals = append([]maps.Decal{}, a.Decals...)
	}
	a.Spawns = append([]core.Vec2{}, a.Spawns...)
	if a.Teams != nil {
		teams := *a.Teams
		teams.Blue.Spawns = append([]core.Vec2{}, teams.Blue.Spawns...)
		teams.Red.Spawns = append([]core.Vec2{}, teams.Red.Spawns...)
		a.Teams = &teams
	}
	return a, nil
}
func (w *World) activateMap(index int) {
	m := w.rotation[index]
	w.Arena = m.arena
	w.Geometry = m.geometry
	for _, p := range w.Players {
		if p.bot != nil && m.navigation != nil {
			p.bot.navigation = m.navigation
		}
	}
}
