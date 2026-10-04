package transport

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"

	"baboreborn/backend/gameconfig"
)

// Save actual state deliveries and WebSocket byte counts for reproducible
// cross-version comparisons. This observer never changes the published bytes.
func TestSnapshotPrecisionCorpus(t *testing.T) {
	dir := os.Getenv("PRECISION_CORPUS")
	if dir == "" {
		t.Skip("set PRECISION_CORPUS to export the current protocol deliveries")
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	var manifest []any
	for _, mapName := range []string{"yard", "crossing", "cryo-lab"} {
		scenarios := []string{"mixed"}
		if mapName == "yard" {
			scenarios = []string{"devices", "grenades", "pickups", "rockets", "molotov", "mixed", "ctf"}
		}
		for _, scenario := range scenarios {
			t.Run(mapName+"/"+scenario, func(t *testing.T) {
				name := mapName + "-" + scenario + ".pbstream"
				path := filepath.Join(dir, name)
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("refusing to overwrite corpus %s", path)
				}
				var corpus []byte
				frames := 0
				result := measureReplication(t, scenario, 1, true, mapName, func(frame []byte) {
					corpus = protowire.AppendBytes(corpus, frame)
					frames++
				})
				if frames != 900 {
					t.Fatalf("expected 900 state deliveries, got %d", frames)
				}
				if err := os.WriteFile(path, corpus, 0600); err != nil {
					t.Fatal(err)
				}
				digest := sha256.Sum256(corpus)
				manifest = append(manifest, map[string]any{"file": name, "sha256": hex.EncodeToString(digest[:]), "frames": frames, "map": mapName, "replay": result})
			})
		}
	}
	writePrecisionJSON(t, filepath.Join(dir, "manifest.json"), map[string]any{"protocol": gameconfig.ProtocolVersion, "players": 16, "recipient": 1, "simulatedSeconds": 30, "results": manifest})
}

func writePrecisionJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, append(data, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s", path)
}
