package content

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"

	"baboreborn/backend/maps"
)

func (c *Catalog) addMaps(source fs.FS) error {
	entries, err := fs.ReadDir(source, "maps")
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			return fmt.Errorf("maps/%s: expected JSON map", entry.Name())
		}
		f, err := source.Open("maps/" + entry.Name())
		if err != nil {
			return err
		}
		data, err := io.ReadAll(io.LimitReader(f, maps.MaxBytes+1))
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		arena, err := maps.Parse(data)
		if err != nil {
			return fmt.Errorf("maps/%s: %w", entry.Name(), err)
		}
		if entry.Name() != arena.ID+".json" {
			return fmt.Errorf("map id must match filename: %s", entry.Name())
		}
		for _, old := range c.Maps {
			if old.ID == arena.ID {
				return fmt.Errorf("duplicate map id %s", arena.ID)
			}
		}
		name := digest(data) + ".json"
		c.files[name] = data
		c.Maps = append(c.Maps, MapInfo{ID: arena.ID, Name: arena.Name, CTF: arena.Teams != nil, File: "/content/v1/files/" + name})
	}
	return nil
}

func (c *Catalog) validateMaps() error {
	if len(c.Maps) == 0 {
		return fmt.Errorf("central catalog requires maps")
	}
	for _, info := range c.Maps {
		arena, err := maps.Parse(c.files[strings.TrimPrefix(info.File, "/content/v1/files/")])
		if err != nil {
			return err
		}
		if err := c.ValidateMap(arena); err != nil {
			return err
		}
	}
	return nil
}
func (c *Catalog) ValidateMap(arena maps.Arena) error {
	for _, decal := range arena.Decals {
		if c.Decal(decal.Asset) == nil {
			return fmt.Errorf("map %s: unknown decal %s", arena.ID, decal.Asset)
		}
	}
	theme := c.Theme(arena.Theme)
	if theme == nil {
		return fmt.Errorf("map %s: unknown theme %s", arena.ID, arena.Theme)
	}
	for _, wall := range arena.Walls {
		if wall.Material != "" {
			if _, ok := theme.Materials[wall.Material]; !ok {
				return fmt.Errorf("map %s: unknown material %s", arena.ID, wall.Material)
			}
		}
	}
	return nil
}
