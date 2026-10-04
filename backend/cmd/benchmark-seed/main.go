// Seed prepares stopped, private benchmark fixtures. It is not a server operator API.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"baboreborn/backend/identity"
	"baboreborn/backend/registry"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/storage"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() (err error) {
	directory := flag.String("data-dir", "", "Private benchmark data directory")
	count := flag.Int("rooms", 1, "Number of benchmark rooms (1..8)")
	clients := flag.Int("clients", 1, "Real clients per room (1..16)")
	mapID := flag.String("map", "yard", "Benchmark map")
	central := flag.String("central", "http://127.0.0.1:18090", "Central origin serving benchmark content")
	flag.Parse()
	if *clients < 1 || *clients > 16 || *directory == "" || *count < 1 || *count > 8 {
		return fmt.Errorf("data directory and 1..8 rooms required")
	}
	ctx := context.Background()
	local, err := storage.OpenLocal(ctx, *directory)
	if err != nil {
		return err
	}
	defer func() {
		if e := local.Close(); err == nil {
			err = e
		}
	}()
	var existing int
	if err = local.DB.QueryRow("SELECT COUNT(*) FROM rooms").Scan(&existing); err != nil {
		return err
	}
	if existing != 0 {
		return fmt.Errorf("benchmark fixture requires an empty directory")
	}
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	descriptor := registry.Descriptor{ID: identity.ID(), Owner: identity.ID(), PublicKey: registry.Public(key), Revision: 1, AppliedRevision: 1, Status: "active"}
	raw, err := json.Marshal(descriptor)
	if err != nil {
		return err
	}
	if _, err = local.DB.Exec("INSERT INTO association(singleton,central,private_key,server_id,owner_id,revision,descriptor) VALUES(1,$5,$1,$2,$3,1,$4)", []byte(key), descriptor.ID, descriptor.Owner, string(raw), *central); err != nil {
		return err
	}
	ids := []string{}
	for range *count {
		id := identity.ID()
		config := hosting.Config{Mode: "dm", Name: "Scheduling measurement", Capacity: 16, Bots: 16 - *clients, Rotation: []string{*mapID}, ScoreLimit: 0, TimeLimitMinutes: 0, RespawnSeconds: 1}
		data, err := json.Marshal(config)
		if err != nil {
			return err
		}
		if _, err = local.DB.Exec("INSERT INTO rooms VALUES($1,$2,'benchmark-fixture','explicit measurement fixture',$3,$3)", id, string(data), time.Now().Unix()); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	return json.NewEncoder(os.Stdout).Encode(ids)
}
