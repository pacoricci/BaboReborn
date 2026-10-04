package content

import (
	"encoding/json"
	"io/fs"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	bundled "baboreborn/content"
)

func packageFS(t *testing.T, id string) fstest.MapFS {
	t.Helper()
	b, err := fs.ReadFile(bundled.Files, "skins/geometric/skin.json")
	if err != nil {
		t.Fatal(err)
	}
	var s Skin
	if err = json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	s.ID = id
	s.Name = "User skin"
	b, err = json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	png, err := fs.ReadFile(bundled.Files, "skins/geometric/mask.png")
	if err != nil {
		t.Fatal(err)
	}
	return fstest.MapFS{"skins/" + id + "/skin.json": {Data: b}, "skins/" + id + "/mask.png": {Data: png}}
}
func TestCatalogDiscoveryValidationAndImmutableHTTP(t *testing.T) {
	c, err := Load(bundled.Files, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Skins) != 15 || len(c.Themes) != 6 {
		t.Fatal("incomplete catalog")
	}
	additions := packageFS(t, "user-pattern")
	if err = c.add(additions); err != nil {
		t.Fatal(err)
	}
	url := c.Skins[len(c.Skins)-1].Mask
	additions["skins/user-pattern/mask.png"].Data = []byte("edited")
	response := httptest.NewRecorder()
	c.ServeHTTP(response, httptest.NewRequest("GET", url, nil))
	if response.Code != 200 || response.Body.Len() < 8 {
		t.Fatal("snapshot mutated")
	}
	if !strings.Contains(response.Header().Get("Cache-Control"), "immutable") {
		t.Fatal("uncached image")
	}
	if err = c.add(packageFS(t, "user-pattern")); err == nil {
		t.Fatal("duplicate accepted")
	}
	for _, path := range []string{"/content/v1/files/../skin.json", "/content/v1/files/not-installed.png"} {
		r := httptest.NewRecorder()
		c.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 404 {
			t.Fatal(path, r.Code)
		}
	}
}
func TestInvalidPackageDiagnostics(t *testing.T) {
	cases := map[string]func(fstest.MapFS){
		"missing":   func(f fstest.MapFS) { delete(f, "skins/user-pattern/mask.png") },
		"corrupt":   func(f fstest.MapFS) { f["skins/user-pattern/mask.png"].Data = []byte("invalid PNG") },
		"oversized": func(f fstest.MapFS) { f["skins/user-pattern/mask.png"].Data = make([]byte, 4*1024*1024+1) },
		"traversal": func(f fstest.MapFS) {
			f["skins/user-pattern/skin.json"].Data = []byte(strings.ReplaceAll(string(f["skins/user-pattern/skin.json"].Data), "mask.png", "../mask.png"))
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := packageFS(t, "user-pattern")
			change(f)
			c := &Catalog{files: map[string][]byte{}}
			if err := c.add(f); err == nil || !strings.Contains(err.Error(), "user-pattern") {
				t.Fatalf("missing diagnostic: %v", err)
			}
		})
	}
}
func TestExternalRestartAndSymlink(t *testing.T) {
	dir := t.TempDir()
	for name, f := range packageFS(t, "custom") {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, f.Data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	c, err := Load(bundled.Files, dir)
	if err != nil {
		t.Fatal(err)
	}
	if !c.SkinIDs()["custom"] {
		t.Fatal("missing external")
	}
	p := filepath.Join(dir, "skins/custom/skin.json")
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(p, []byte(strings.ReplaceAll(string(b), "User skin", "Renamed skin")), 0600); err != nil {
		t.Fatal(err)
	}
	next, err := Load(bundled.Files, dir)
	if err != nil {
		t.Fatal(err)
	}
	if c.Revision == next.Revision {
		t.Fatal("stale revision")
	}
	if err = os.Symlink(p, filepath.Join(dir, "linked.json")); err != nil {
		t.Fatal(err)
	}
	if _, err = Load(bundled.Files, dir); err == nil {
		t.Fatal("accepted symlink")
	}
}

func TestSharedManifestCases(t *testing.T) {
	data, err := os.ReadFile("../../content/content-validation.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Kind  string
		Patch map[string]any
		Valid bool
	}
	if err = json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		folder := "skins/geometric"
		if c.Kind == "theme" {
			folder = "themes/classic"
		}
		raw, err := fs.ReadFile(bundled.Files, folder+"/"+c.Kind+".json")
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err = json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		for key, v := range c.Patch {
			value[key] = v
		}
		raw, err = json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		source := fstest.MapFS{}
		id := value["id"].(string)
		kind := c.Kind + "s"
		entries, err := fs.ReadDir(bundled.Files, folder)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			b, err := fs.ReadFile(bundled.Files, folder+"/"+entry.Name())
			if err != nil {
				t.Fatal(err)
			}
			source[kind+"/"+id+"/"+entry.Name()] = &fstest.MapFile{Data: b}
		}
		source[kind+"/"+id+"/"+c.Kind+".json"] = &fstest.MapFile{Data: raw}
		catalog := &Catalog{files: map[string][]byte{}}
		err = catalog.add(source)
		if (err == nil) != c.Valid {
			t.Fatalf("%s %v: %v", c.Kind, c.Patch, err)
		}
	}
}

func TestWebPThemeValidationAndServing(t *testing.T) {
	c, err := Load(bundled.Files, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, theme := range c.Themes {
		response := httptest.NewRecorder()
		c.ServeHTTP(response, httptest.NewRequest("GET", theme.Floor, nil))
		if response.Code != 200 || response.Header().Get("Content-Type") != "image/webp" || !strings.HasSuffix(theme.Floor, ".webp") {
			t.Fatal(theme.ID, response)
		}
	}
	source := fstest.MapFS{}
	err = fs.WalkDir(bundled.Files, "themes/classic", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(bundled.Files, name)
		if err != nil {
			return err
		}
		source[name] = &fstest.MapFile{Data: data}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	source["themes/classic/floor.webp"].Data = []byte("RIFFinvalid WEBP")
	empty := &Catalog{files: map[string][]byte{}}
	if err := empty.add(source); err == nil {
		t.Fatal("corrupt WebP accepted")
	}
}
