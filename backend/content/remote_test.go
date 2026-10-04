package content

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"baboreborn/backend/internal/testcontent"
	bundled "baboreborn/content"
)

func TestCentralCatalogCDNAndVerifiedRoomPreparation(t *testing.T) {
	c, err := Load(bundled.Files, "")
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	cdn := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); c.ServeHTTP(w, r) }))
	defer cdn.Close()
	if err = c.SetFileOrigin(cdn.URL, true); err != nil {
		t.Fatal(err)
	}
	central := httptest.NewServer(c)
	defer central.Close()
	remote, err := OpenRemote(context.Background(), central.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 0 {
		t.Fatal("startup downloaded map or image files")
	}
	if len(remote.Catalog.Maps) != len(testcontent.Maps()) {
		t.Fatal("missing central maps")
	}
	arenas, err := remote.Rotation(context.Background(), []string{"yard", "crossing", "yard"})
	if err != nil {
		t.Fatal(err)
	}
	if len(arenas) != 3 || arenas[0].ID != "yard" || arenas[1].ID != "crossing" || requests.Load() != 3 {
		t.Fatal("rotation differs from selected central maps")
	}
	cdn.Close()
	if _, err = remote.Rotation(context.Background(), []string{"yard"}); err == nil {
		t.Fatal("unexpected cache or fallback after CDN outage")
	}
	if arenas[0].ID != "yard" || len(arenas[0].Walls) == 0 {
		t.Fatal("prepared in-memory maps lost on outage")
	}
}

func TestRemoteRejectsCorruptionMissingContentAndInvalidCatalog(t *testing.T) {
	for _, mode := range []string{"corrupt", "missing", "stale", "redirect"} {
		t.Run(mode, func(t *testing.T) {
			c, err := Load(bundled.Files, "")
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/content/v1/catalog" {
					if mode == "stale" {
						c.Revision = strings.Repeat("0", 64)
					}
					c.ServeHTTP(w, r)
					return
				}
				switch mode {
				case "corrupt":
					if _, err := w.Write(testcontent.Map("crossing")); err != nil {
						t.Error(err)
					}
				case "missing":
					http.NotFound(w, r)
				case "redirect":
					http.Redirect(w, r, "/content/v1/catalog", http.StatusFound)
				default:
					c.ServeHTTP(w, r)
				}
			}))
			defer server.Close()
			remote, err := OpenRemote(context.Background(), server.URL, true)
			if mode == "stale" {
				if err == nil {
					t.Fatal("stale catalog accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = remote.Rotation(context.Background(), []string{"yard"}); err == nil {
				t.Fatal("unusable map accepted")
			}
		})
	}
}

func TestPublicContentHeadersAndDistributionIdentity(t *testing.T) {
	c, err := Load(bundled.Files, "")
	if err != nil {
		t.Fatal(err)
	}
	revision := c.Revision
	if err = c.SetFileOrigin("https://cdn.example.test", false); err != nil {
		t.Fatal(err)
	}
	if c.Revision != revision {
		t.Fatal("CDN configuration changed content identity")
	}
	if err = c.validateRemote(false); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/content/v1/catalog", c.Maps[0].File, c.Skins[0].Mask} {
		r := httptest.NewRecorder()
		c.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		if r.Code != 200 || r.Header().Get("Access-Control-Allow-Origin") != "*" {
			t.Fatal(path, r.Code, r.Header())
		}
		if strings.HasSuffix(path, "catalog") {
			var catalog Catalog
			if err = json.Unmarshal(r.Body.Bytes(), &catalog); err != nil {
				t.Fatal(err)
			}
			if r.Header().Get("Cache-Control") != "no-cache" || catalog.FileOrigin != c.FileOrigin {
				t.Fatal("catalog caching or CDN origin")
			}
		} else if !strings.Contains(r.Header().Get("Cache-Control"), "immutable") {
			t.Fatal("file not immutable")
		}
	}
	for _, origin := range []string{"http://cdn.example.test", "https://user:pass@cdn.example.test", "https://cdn.example.test/path"} {
		if err = c.SetFileOrigin(origin, false); err == nil {
			t.Fatal("invalid origin accepted", origin)
		}
	}
}
