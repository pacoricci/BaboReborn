package content

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/maps"
)

var imageFile = regexp.MustCompile(`^/content/v1/files/[a-f0-9]{64}\.(png|webp)$`)
var mapFile = regexp.MustCompile(`^/content/v1/files/[a-f0-9]{64}\.json$`)
var revisionID = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Changing distribution origins does not change the identity of the content.
func (c *Catalog) SetFileOrigin(origin string, development bool) error {
	if origin != "" {
		canonical, err := identity.CanonicalOrigin(origin, development)
		if err != nil {
			return fmt.Errorf("invalid content origin: %w", err)
		}
		origin = canonical
	}
	c.FileOrigin = origin
	return nil
}

// Remote pins one central catalog for the lifetime of a server process. Map bytes
// are fetched only while preparing a room; no disk cache or background sync exists.
type Remote struct {
	Catalog *Catalog
	origin  string
	client  *http.Client
}

func OpenRemote(ctx context.Context, central string, development bool) (*Remote, error) {
	origin, err := identity.CanonicalOrigin(central, development)
	if err != nil {
		return nil, err
	}
	r := &Remote{origin: origin, client: &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("content redirects are not supported") }}}
	data, err := r.get(ctx, origin+"/content/v1/catalog", 2<<20)
	if err != nil {
		return nil, fmt.Errorf("central content catalog: %w", err)
	}
	var c Catalog
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err = d.Decode(&c); err != nil {
		return nil, err
	}
	if d.Decode(new(any)) != io.EOF {
		return nil, fmt.Errorf("invalid catalog JSON")
	}
	if err = c.validateRemote(development); err != nil {
		return nil, err
	}
	r.Catalog = &c
	if c.FileOrigin != "" {
		r.origin = c.FileOrigin
	}
	return r, nil
}
func (r *Remote) get(ctx context.Context, url string, limit int64) (data []byte, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		if closeErr := response.Body.Close(); err == nil {
			err = closeErr
		}
	}()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	data, err = io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("content exceeds byte limit")
	}
	return data, nil
}
func (c *Catalog) validateRemote(development bool) error {
	if c.Schema != SchemaVersion || c.Decals == nil || !revisionID.MatchString(c.Revision) || len(c.Maps) == 0 || len(c.Skins) == 0 || len(c.Themes) == 0 {
		return fmt.Errorf("invalid central catalog")
	}
	if err := c.SetFileOrigin(c.FileOrigin, development); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, d := range c.Decals {
		if d.validate() != nil || !imageFile.MatchString(d.Texture) || seen["decal:"+d.ID] {
			return fmt.Errorf("invalid central decal")
		}
		seen["decal:"+d.ID] = true
	}
	for _, s := range c.Skins {
		if s.validate() != nil || !imageFile.MatchString(s.Mask) || !strings.HasSuffix(s.Mask, ".png") || seen["skin:"+s.ID] {
			return fmt.Errorf("invalid central skin")
		}
		seen["skin:"+s.ID] = true
	}
	for _, t := range c.Themes {
		if t.Validate() != nil || !imageFile.MatchString(t.Floor) || t.Earth != "" && !imageFile.MatchString(t.Earth) || seen["theme:"+t.ID] {
			return fmt.Errorf("invalid central theme")
		}
		for _, m := range t.Materials {
			if !imageFile.MatchString(m.Wall) || !imageFile.MatchString(m.Top) {
				return fmt.Errorf("invalid central material")
			}
		}
		seen["theme:"+t.ID] = true
	}
	for _, m := range c.Maps {
		if !identifier.MatchString(m.ID) || strings.TrimSpace(m.Name) == "" || len([]rune(m.Name)) > 80 || !mapFile.MatchString(m.File) || seen["map:"+m.ID] {
			return fmt.Errorf("invalid central map")
		}
		seen["map:"+m.ID] = true
	}
	if !seen["skin:"+c.DefaultSkin] || !seen["theme:"+c.DefaultTheme] {
		return fmt.Errorf("invalid central defaults")
	}
	copy := *c
	copy.Revision = ""
	copy.FileOrigin = ""
	raw, err := json.Marshal(&copy)
	if err != nil {
		return err
	}
	if digest(raw) != c.Revision {
		return fmt.Errorf("central catalog revision mismatch")
	}
	return nil
}
func (r *Remote) Rotation(ctx context.Context, ids []string) ([]maps.Arena, error) {
	arenas := make([]maps.Arena, 0, len(ids))
	// One bounded preparation covers the whole rotation, never the simulation loop.
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for _, id := range ids {
		var info *MapInfo
		for i := range r.Catalog.Maps {
			if r.Catalog.Maps[i].ID == id {
				info = &r.Catalog.Maps[i]
				break
			}
		}
		if info == nil {
			return nil, fmt.Errorf("unknown central map %s", id)
		}
		data, err := r.get(ctx, r.origin+info.File, maps.MaxBytes)
		if err != nil {
			return nil, fmt.Errorf("map %s unavailable: %w", id, err)
		}
		if "/content/v1/files/"+digest(data)+".json" != info.File {
			return nil, fmt.Errorf("map %s digest mismatch", id)
		}
		a, err := maps.Parse(data)
		if err != nil {
			return nil, err
		}
		if a.ID != id || a.Name != info.Name || (a.Teams != nil) != info.CTF {
			return nil, fmt.Errorf("map %s metadata mismatch", id)
		}
		if err = r.Catalog.ValidateMap(a); err != nil {
			return nil, err
		}
		arenas = append(arenas, a)
	}
	return arenas, nil
}
