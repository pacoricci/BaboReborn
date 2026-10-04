// Package content validates and serves centralized maps and cosmetic packages.
package content

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image/png"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/image/webp"
)

type Metadata struct {
	Schema int    `json:"schema"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Author string `json:"author"`
}
type Skin struct {
	Metadata
	Mask string `json:"mask"`
}
type Decal struct {
	Metadata
	Texture string `json:"texture"`
}
type Material struct {
	Name     string  `json:"name"`
	Wall     string  `json:"wall"`
	Top      string  `json:"top"`
	Tile     float64 `json:"tile"`     // [cells]
	Emission float64 `json:"emission"` // [ratio]
	WallHue  float64 `json:"wallHue"`  // [degrees]
}
type Theme struct {
	Metadata
	Floor           string              `json:"floor"`
	FloorTile       float64             `json:"floorTile"` // [cells]
	DefaultMaterial string              `json:"defaultMaterial"`
	Materials       map[string]Material `json:"materials"`
	Background      string              `json:"background"`
	GroundLight     string              `json:"groundLight"`
	PlanFloor       string              `json:"planFloor"`
	OutdoorWear     bool                `json:"outdoorWear"`
	Earth           string              `json:"earth,omitempty"`
}
type MapInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	CTF  bool   `json:"ctf"`
	File string `json:"file"`
}

type Catalog struct {
	Decals       []Decal   `json:"decals"`
	FileOrigin   string    `json:"fileOrigin"`
	Maps         []MapInfo `json:"maps"`
	Schema       int       `json:"schema"`
	Revision     string    `json:"revision"`
	DefaultSkin  string    `json:"defaultSkin"`
	DefaultTheme string    `json:"defaultTheme"`
	Skins        []Skin    `json:"skins"`
	Themes       []Theme   `json:"themes"`
	files        map[string][]byte
}

var timeZero time.Time
var identifier = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
var color = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func decode(data []byte, target any) error {
	if len(data) > 65536 {
		return fmt.Errorf("manifest exceeds 64 KiB")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	required := []string{"schema", "id", "name", "author"}
	switch target.(type) {
	case *Skin:
		required = append(required, "mask")
	case *Decal:
		required = append(required, "texture")
	case *Theme:
		required = append(required, "floor", "floorTile", "defaultMaterial", "materials", "background", "groundLight", "planFloor", "outdoorWear")
	}
	for _, key := range required {
		if raw, ok := fields[key]; !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("missing or null %s", key)
		}
	}
	if raw, ok := fields["materials"]; ok {
		var materials map[string]map[string]json.RawMessage
		if err := json.Unmarshal(raw, &materials); err != nil {
			return err
		}
		for id, m := range materials {
			for _, key := range []string{"name", "wall", "top", "tile", "emission", "wallHue"} {
				if value, ok := m[key]; !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
					return fmt.Errorf("material %s: missing or null %s", id, key)
				}
			}
		}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("expected one JSON object")
	}
	return nil
}
func (m Metadata) validate() error {
	if m.Schema != ManifestSchemaVersion || !identifier.MatchString(m.ID) {
		return fmt.Errorf("invalid schema or id")
	}
	for name, value := range map[string]string{"name": m.Name, "author": m.Author} {
		if strings.TrimSpace(value) == "" || len([]rune(value)) > 512 {
			return fmt.Errorf("invalid %s", name)
		}
	}
	return nil
}

// Load takes immutable snapshots of validated bytes; only these bytes can be served.
func Load(bundled fs.FS, external string) (*Catalog, error) {
	c := &Catalog{Schema: SchemaVersion, Decals: []Decal{}, DefaultSkin: "geometric", DefaultTheme: "classic", files: map[string][]byte{}}
	if err := c.add(bundled); err != nil {
		return nil, err
	}
	if external != "" {
		if err := filepath.WalkDir(external, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("content symlink: %s", p)
			}
			return nil
		}); err != nil {
			return nil, err
		}
		if err := c.add(os.DirFS(external)); err != nil {
			return nil, err
		}
	}
	if err := c.validateMaps(); err != nil {
		return nil, err
	}
	sort.Slice(c.Maps, func(i, j int) bool { return c.Maps[i].ID < c.Maps[j].ID })
	sort.Slice(c.Skins, func(i, j int) bool { return c.Skins[i].ID < c.Skins[j].ID })
	sort.Slice(c.Themes, func(i, j int) bool { return c.Themes[i].ID < c.Themes[j].ID })
	sort.Slice(c.Decals, func(i, j int) bool { return c.Decals[i].ID < c.Decals[j].ID })
	if !c.SkinIDs()[c.DefaultSkin] || c.Theme(c.DefaultTheme) == nil {
		return nil, fmt.Errorf("default content missing")
	}
	data, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	c.Revision = digest(data)

	return c, nil
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func (c *Catalog) add(source fs.FS) error {
	for _, kind := range []string{"skins", "themes", "decals"} {
		entries, err := fs.ReadDir(source, kind)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				return fmt.Errorf("%s/%s: expected package directory", kind, entry.Name())
			}
			dir := path.Join(kind, entry.Name())
			var packageBytes int64
			if err := fs.WalkDir(source, dir, func(name string, entry fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if entry.IsDir() {
					return nil
				}
				info, err := entry.Info()
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() {
					return fmt.Errorf("%s: expected regular file", name)
				}
				packageBytes += info.Size()
				if packageBytes > 16*1024*1024 {
					return fmt.Errorf("%s: package exceeds 16 MiB", dir)
				}
				return nil
			}); err != nil {
				return err
			}

			manifest := strings.TrimSuffix(kind, "s") + ".json"
			data, err := fs.ReadFile(source, path.Join(dir, manifest))
			if err != nil {
				return fmt.Errorf("%s: %w", dir, err)
			}
			total := 0
			resolved := map[string]string{}
			image := func(file string, skin bool) (string, error) {
				if v, ok := resolved[file]; ok {
					return v, nil
				}
				ext := path.Ext(file)
				if !fs.ValidPath(file) || strings.ContainsAny(file, "\\:%?#") || (ext != ".png" && (skin || ext != ".webp")) {
					return "", fmt.Errorf("invalid image path %q", file)
				}
				f, err := source.Open(path.Join(dir, file))
				if err != nil {
					return "", err
				}
				b, err := io.ReadAll(io.LimitReader(f, 4*1024*1024+1))
				closeErr := f.Close()
				if err != nil {
					return "", err
				}
				if closeErr != nil {
					return "", closeErr
				}
				total += len(b)
				if len(b) > 4*1024*1024 || total > 16*1024*1024 {
					return "", fmt.Errorf("image/package byte limit exceeded")
				}
				decodeConfig, decode := png.DecodeConfig, png.Decode
				if ext == ".webp" {
					decodeConfig, decode = webp.DecodeConfig, webp.Decode
				}
				config, err := decodeConfig(bytes.NewReader(b))
				if err != nil {
					return "", fmt.Errorf("%s: %w", file, err)
				}
				if config.Width > 1024 || config.Height > 1024 || skin && (config.Width != 512 || config.Height != 256) {
					return "", fmt.Errorf("%s: invalid dimensions", file)
				}
				if _, err = decode(bytes.NewReader(b)); err != nil {
					return "", fmt.Errorf("%s: %w", file, err)
				}
				hash := digest(b) + ext
				c.files[hash] = b
				url := "/content/v1/files/" + hash
				resolved[file] = url
				return url, nil
			}
			switch kind {
			case "skins":
				var s Skin
				if err = decode(data, &s); err == nil {
					err = s.validate()
				}
				if err != nil {
					return fmt.Errorf("%s: %w", dir, err)
				}
				if c.SkinIDs()[s.ID] {
					return fmt.Errorf("%s: duplicate skin id %s", dir, s.ID)
				}
				if s.ID != entry.Name() {
					return fmt.Errorf("%s: id must match directory", dir)
				}
				s.Mask, err = image(s.Mask, true)
				if err != nil {
					return fmt.Errorf("%s mask: %w", dir, err)
				}
				c.Skins = append(c.Skins, s)
			case "decals":
				var d Decal
				if err = decode(data, &d); err == nil {
					err = d.validate()
				}
				if err != nil {
					return fmt.Errorf("%s: %w", dir, err)
				}
				if c.Decal(d.ID) != nil || d.ID != entry.Name() {
					return fmt.Errorf("%s: duplicate or mismatched decal id", dir)
				}
				d.Texture, err = image(d.Texture, false)
				if err != nil {
					return fmt.Errorf("%s texture: %w", dir, err)
				}
				c.Decals = append(c.Decals, d)
			case "themes":
				var t Theme
				if err = decode(data, &t); err == nil {
					err = t.Validate()
				}
				if err != nil {
					return fmt.Errorf("%s: %w", dir, err)
				}
				if c.Theme(t.ID) != nil {
					return fmt.Errorf("%s: duplicate theme id %s", dir, t.ID)
				}
				if t.ID != entry.Name() {
					return fmt.Errorf("%s: id must match directory", dir)
				}
				t.Floor, err = image(t.Floor, false)
				if err != nil {
					return fmt.Errorf("%s floor: %w", dir, err)
				}
				if t.Earth != "" {
					t.Earth, err = image(t.Earth, false)
					if err != nil {
						return fmt.Errorf("%s earth: %w", dir, err)
					}
				}
				for id, m := range t.Materials {
					m.Wall, err = image(m.Wall, false)
					if err != nil {
						return fmt.Errorf("%s material %s wall: %w", dir, id, err)
					}
					m.Top, err = image(m.Top, false)
					if err != nil {
						return fmt.Errorf("%s material %s top: %w", dir, id, err)
					}
					t.Materials[id] = m
				}
				c.Themes = append(c.Themes, t)
			}
		}
	}
	return c.addMaps(source)
}
func (t Theme) Validate() error {
	if err := t.validate(); err != nil {
		return err
	}
	if !color.MatchString(t.Background) || !color.MatchString(t.GroundLight) || !color.MatchString(t.PlanFloor) || t.FloorTile <= 0 || t.FloorTile > 64 || len(t.Materials) < 1 || len(t.Materials) > 8 {
		return fmt.Errorf("invalid theme colors, tiling or material count")
	}
	if _, ok := t.Materials[t.DefaultMaterial]; !ok {
		return fmt.Errorf("defaultMaterial missing")
	}
	if t.OutdoorWear && t.Earth == "" {
		return fmt.Errorf("outdoorWear requires earth")
	}
	for id, m := range t.Materials {
		if !identifier.MatchString(id) || strings.TrimSpace(m.Name) == "" || m.Tile <= 0 || m.Tile > 64 || m.Emission < 0 || m.Emission > 1 || m.WallHue < 0 || m.WallHue > 360 {
			return fmt.Errorf("invalid material %s", id)
		}
	}
	return nil
}
func (c *Catalog) SkinIDs() map[string]bool {
	m := map[string]bool{}
	for _, s := range c.Skins {
		m[s.ID] = true
	}
	return m
}
func (c *Catalog) Theme(id string) *Theme {
	for i := range c.Themes {
		if c.Themes[i].ID == id {
			return &c.Themes[i]
		}
	}
	return nil
}
func (c *Catalog) Decal(id string) *Decal {
	for i := range c.Decals {
		if c.Decals[i].ID == id {
			return &c.Decals[i]
		}
	}
	return nil
}
func (c *Catalog) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "HEAD" {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	// Public immutable content is credential-free, including when cached by a CDN.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Path == "/content/v1/catalog" {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-cache")
		if r.Method == "GET" {
			if err := json.NewEncoder(w).Encode(c); err != nil {
				return
			}
		}
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/content/v1/files/") {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/content/v1/files/")
	data, ok := c.files[name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if strings.HasSuffix(name, ".json") {
		w.Header().Set("Content-Type", "application/json")
	} else if strings.HasSuffix(name, ".webp") {
		w.Header().Set("Content-Type", "image/webp")
	} else {
		w.Header().Set("Content-Type", "image/png")
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+name+`"`)
	http.ServeContent(w, r, name /* stable snapshot */, timeZero, bytes.NewReader(data))
}
