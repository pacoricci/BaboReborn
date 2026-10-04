// Package maps defines and validates authored map data, independent of match lifecycle.
package maps

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"strings"
	"unicode/utf8"

	"baboreborn/backend/core"
)

const MaxBytes = 1 << 20

var identifier = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

type TeamBase struct {
	Base   core.Vec2   `json:"base"`
	Spawns []core.Vec2 `json:"spawns"`
}
type TeamLayout struct {
	Blue TeamBase `json:"blue"`
	Red  TeamBase `json:"red"`
}
type Arena struct {
	Decals []Decal     `json:"decals,omitempty"`
	Theme  string      `json:"theme,omitempty"`
	Teams  *TeamLayout `json:"teams,omitempty"`
	Schema int         `json:"schema"`
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Author string      `json:"author"`
	Width  float64     `json:"width"`
	Height float64     `json:"height"`
	Walls  []Wall      `json:"walls"`
	Spawns []core.Vec2 `json:"spawns"`
}

func Parse(data []byte) (Arena, error) {
	var a Arena
	if len(data) > MaxBytes {
		return a, fmt.Errorf("map exceeds 1 MiB")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&a); err != nil {
		return a, fmt.Errorf("map JSON: %w", err)
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return a, fmt.Errorf("map must contain one JSON object")
	}
	// An omitted height uses the gameplay fallback; explicit zero/null is an error.
	var authored struct {
		Decals json.RawMessage              `json:"decals"`
		Theme  json.RawMessage              `json:"theme"`
		Walls  []map[string]json.RawMessage `json:"walls"`
		Spawns []map[string]json.RawMessage `json:"spawns"`
	}
	if err := json.Unmarshal(data, &authored); err != nil {
		return a, err
	}
	if authored.Theme != nil && a.Theme == "" {
		return a, fmt.Errorf("map theme must be a supported nonempty string when supplied")
	}
	if authored.Decals != nil {
		if a.Schema != SchemaVersion || bytes.Equal(bytes.TrimSpace(authored.Decals), []byte("null")) {
			return a, fmt.Errorf("decals require a schema %d array", SchemaVersion)
		}
		var decals []map[string]json.RawMessage
		if err := json.Unmarshal(authored.Decals, &decals); err != nil {
			return a, err
		}
		for _, d := range decals {
			for _, key := range []string{"asset", "x", "y", "w", "h", "angle", "opacity"} {
				if raw, ok := d[key]; !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
					return a, fmt.Errorf("decal requires %s", key)
				}
			}
		}
	}
	for _, group := range []struct {
		values []map[string]json.RawMessage
		fields []string
	}{{authored.Walls, []string{"x", "y", "w", "h"}}, {authored.Spawns, []string{"x", "y"}}} {
		for _, item := range group.values {
			for _, field := range group.fields {
				raw, ok := item[field]
				if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
					return a, fmt.Errorf("map geometry requires numeric %s", field)
				}
			}
		}
	}
	for i, w := range authored.Walls {
		if raw, ok := w["height"]; ok {
			var height float64
			if err := json.Unmarshal(raw, &height); err != nil || height <= 0 {
				return a, fmt.Errorf("wall %d height must be positive when supplied", i)
			}
		}
	}
	return a, a.Validate()
}

func (a Arena) Validate() error {
	if !identifier.MatchString(a.Theme) {
		return fmt.Errorf("invalid theme id")
	}
	for _, wall := range a.Walls {
		if wall.Material != "" && !identifier.MatchString(wall.Material) {
			return fmt.Errorf("invalid wall material")
		}
	}
	whole := func(v, min, max float64) bool {
		return !math.IsNaN(v) && !math.IsInf(v, 0) && v == math.Trunc(v) && v >= min && v <= max
	}
	if a.Schema != SchemaVersion {
		return fmt.Errorf("map schema must be %d", SchemaVersion)
	}
	if len(a.Decals) > MaxDecals {
		return fmt.Errorf("map allows at most %d decals", MaxDecals)
	}
	for i, d := range a.Decals {
		if !d.valid(a.Width, a.Height) {
			return fmt.Errorf("decal %d has invalid asset, bounds or appearance", i)
		}
	}
	if !identifier.MatchString(a.ID) {
		return fmt.Errorf("map id must be 1..48 lowercase letters, digits or hyphens")
	}
	for field, value := range map[string]string{"name": a.Name, "author": a.Author} {
		if strings.TrimSpace(value) == "" || utf8.RuneCountInString(value) > 80 {
			return fmt.Errorf("map %s must be 1..80 characters", field)
		}
	}
	if !whole(a.Width, 8, 128) || !whole(a.Height, 8, 128) {
		return fmt.Errorf("map width and height must be integers in 8..128")
	}
	if a.Walls == nil || len(a.Walls) > 4096 {
		return fmt.Errorf("map walls must be an array of at most 4096 rectangles")
	}
	for i, w := range a.Walls {
		if !whole(w.X, 0, a.Width-1) || !whole(w.Y, 0, a.Height-1) || !whole(w.W, 1, a.Width-w.X) || !whole(w.H, 1, a.Height-w.Y) || math.IsNaN(w.Height) || math.IsInf(w.Height, 0) || w.Height < 0 || w.Height > 64 {
			return fmt.Errorf("wall %d has invalid bounds or height", i)
		}
	}
	if len(a.Spawns) < 1 || len(a.Spawns) > 64 {
		return fmt.Errorf("map needs 1..64 spawns")
	}
	margin := core.Radius + core.Clearance
	for i, p := range a.Spawns {
		if math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsInf(p.X, 0) || math.IsInf(p.Y, 0) || p.X < 1+margin || p.Y < 1+margin || p.X > a.Width-1-margin || p.Y > a.Height-1-margin {
			return fmt.Errorf("spawn %d must clear the map boundary", i)
		}
		for _, w := range a.Walls {
			if p.X > w.X-margin && p.X < w.X+w.W+margin && p.Y > w.Y-margin && p.Y < w.Y+w.H+margin {
				return fmt.Errorf("spawn %d overlaps a wall or lacks player clearance", i)
			}
		}
	}
	if a.Teams != nil {
		// Reuse the same clearance rules for bases and team spawn points.
		for _, side := range []TeamBase{a.Teams.Blue, a.Teams.Red} {
			if len(side.Spawns) < 1 || len(side.Spawns) > 32 {
				return fmt.Errorf("team needs 1..32 spawns")
			}
			copy := a
			copy.Teams = nil
			copy.Spawns = append([]core.Vec2{side.Base}, side.Spawns...)
			if err := copy.Validate(); err != nil {
				return fmt.Errorf("team layout: %w", err)
			}
		}
		if math.Hypot(a.Teams.Blue.Base.X-a.Teams.Red.Base.X, a.Teams.Blue.Base.Y-a.Teams.Red.Base.Y) < 4 {
			return fmt.Errorf("bases must be at least four cells apart")
		}
	}
	return nil
}

// Wall keeps cosmetic references outside the core geometry contract.
type Wall struct {
	core.Wall
	Material string `json:"material,omitempty"`
}

func (a Arena) GeometryWalls() []core.Wall {
	walls := make([]core.Wall, len(a.Walls))
	for i, w := range a.Walls {
		walls[i] = w.Wall
	}
	return walls
}
