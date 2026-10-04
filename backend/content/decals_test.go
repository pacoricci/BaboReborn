package content

import (
	"encoding/json"
	"io/fs"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"baboreborn/backend/internal/testcontent"
	"baboreborn/backend/maps"
	bundled "baboreborn/content"
)

func TestDecalCatalogAssetsReferencesAndRemoteValidation(t *testing.T) {
	c, err := Load(bundled.Files, "")
	if err != nil {
		t.Fatal(err)
	}
	if c.Schema != SchemaVersion || len(c.Decals) != 7 {
		t.Fatal("incomplete decal catalog")
	}
	for _, d := range c.Decals {
		r := httptest.NewRecorder()
		c.ServeHTTP(r, httptest.NewRequest("GET", d.Texture, nil))
		if r.Code != 200 || r.Header().Get("Content-Type") != "image/png" {
			t.Fatal("decal image unavailable")
		}
	}
	for _, data := range testcontent.Maps() {
		arena, err := maps.Parse(data)
		if err != nil {
			t.Fatal(err)
		}
		if len(arena.Decals) == 0 {
			t.Fatalf("bundled map %s has no decals", arena.ID)
		}
		if err := c.ValidateMap(arena); err != nil {
			t.Fatal(err)
		}
	}
	a, err := maps.Parse(testcontent.Map("ion-foundry"))
	if err != nil {
		t.Fatal(err)
	}
	a.Decals[0].Asset = "missing"
	if c.ValidateMap(a) == nil {
		t.Fatal("unknown asset accepted")
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var remote Catalog
	if err := json.Unmarshal(raw, &remote); err != nil {
		t.Fatal(err)
	}
	if err := remote.validateRemote(true); err != nil {
		t.Fatal(err)
	}
	remote.Decals[0].Texture = "https://outside.test/texture.png"
	if remote.validateRemote(true) == nil {
		t.Fatal("external image reference accepted")
	}
	manifest, err := fs.ReadFile(bundled.Files, "decals/oil/decal.json")
	if err != nil {
		t.Fatal(err)
	}
	image, err := fs.ReadFile(bundled.Files, "decals/oil/texture.png")
	if err != nil {
		t.Fatal(err)
	}
	source := fstest.MapFS{"decals/oil/decal.json": {Data: manifest}, "decals/oil/texture.png": {Data: image}}
	if c.add(source) == nil {
		t.Fatal("duplicate decal accepted")
	}
	var fields map[string]any
	if err := json.Unmarshal(manifest, &fields); err != nil {
		t.Fatal(err)
	}
	fields["id"] = "custom"
	fields["texture"] = "../texture.png"
	manifest, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	source = fstest.MapFS{"decals/custom/decal.json": {Data: manifest}}
	if c.add(source) == nil {
		t.Fatal("texture traversal accepted")
	}
}
