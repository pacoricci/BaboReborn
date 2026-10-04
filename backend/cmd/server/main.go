package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/content"
	"baboreborn/backend/server/access"
	"baboreborn/backend/server/administration"
	"baboreborn/backend/server/hosting"
	"baboreborn/backend/server/registration"
	"baboreborn/backend/server/storage"
	"baboreborn/backend/server/transport"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() (err error) {
	directory := flag.String("data-dir", ".data/server", "Private database and key cache directory")
	operation := flag.String("storage", "serve", "serve, initialize, backup or restore (offline)")
	backup := flag.String("backup-file", "", "Backup source/destination")
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP listen address")
	development := flag.Bool("development", false, "Allow HTTP on loopback for local development")
	pairing := flag.String("pairing-code-file", "", "File containing the single-use portal association code")
	central := flag.String("central", "", "Required portal origin")
	maxRooms := flag.Int("max-rooms", 8, "Maximum total persistent rooms (1..32)")
	cert := flag.String("tls-cert", "", "TLS certificate file")
	key := flag.String("tls-key", "", "TLS private key file")
	diagnostics := flag.Bool("diagnostics", false, "Serve loopback-only delivery traces; keep off behind a same-host proxy")
	flag.Parse()
	if *operation != "serve" && *operation != "initialize" && *operation != "backup" && *operation != "restore" {
		return fmt.Errorf("unknown storage operation")
	}
	if (*operation == "backup" || *operation == "restore") && *backup == "" {
		return fmt.Errorf("backup-file required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	startup, end := context.WithTimeout(ctx, 30*time.Second)
	defer end()
	if *operation == "restore" {
		return storage.RestoreLocal(startup, *directory, *backup)
	}
	local, err := storage.OpenLocal(startup, *directory)
	if err != nil {
		return err
	}
	defer func() {
		if e := local.Close(); err == nil {
			err = e
		}
	}()
	if *operation == "initialize" {
		return nil
	}
	if *operation == "backup" {
		return local.Backup(startup, *backup)
	}
	reg, err := registration.Open(startup, local.DB, *central, *pairing, *development, compatibility.Current())
	if err != nil {
		return err
	}
	auth, err := access.New(access.Config{Origin: *central, Central: *central, Development: *development, KeysPath: filepath.Join(*directory, "identity-keys.json"), Association: reg.Snapshot})
	if err != nil {
		return err
	}
	if *maxRooms < 1 || *maxRooms > 32 {
		return fmt.Errorf("max-rooms must be 1..32")
	}
	if (*cert == "") != (*key == "") {
		return fmt.Errorf("tls-cert and tls-key must be provided together")
	}
	if !*development && *cert == "" {
		return fmt.Errorf("TLS is required outside loopback development")
	}
	remote, err := content.OpenRemote(startup, *central, *development)
	if err != nil {
		return err
	}
	catalog := make([]hosting.MapInfo, 0, len(remote.Catalog.Maps))
	for _, info := range remote.Catalog.Maps {
		catalog = append(catalog, hosting.MapInfo{ID: info.ID, Name: info.Name, CTF: info.CTF})
	}
	parsed, err := url.Parse(*central)
	if err != nil {
		return err
	}
	rooms := hosting.New(ctx, catalog, func(ctx context.Context, c hosting.Config) (*transport.Server, error) {
		arenas, err := remote.Rotation(ctx, c.Rotation)
		if err != nil {
			return nil, err
		}
		return configuredRoom(c, arenas, []string{parsed.Host}, remote.Catalog)
	}, *maxRooms)
	admin := administration.New(ctx, local.DB, auth, rooms)
	reg.Apply = admin.ApplyAssociation
	reg.Publication = admin.Publication
	reg.Verify = auth.VerifyRegistry
	if err = admin.Load(startup); err != nil {
		return err
	}
	if err = auth.RefreshKeys(startup); err != nil {
		log.Printf("Central key refresh unavailable; cached keys retained")
	}
	go auth.Run(ctx)
	go admin.Run(ctx)
	go reg.Run(ctx)
	base := routes(rooms, transport.LatencyHandler(ctx, *central), *diagnostics)
	server := &http.Server{Addr: *addr, Handler: auth.CORS(reg.Handler(admin.Handler(base))), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.Background(), 3*time.Second)
		defer done()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("HTTP shutdown: %v", err)
		}
	}()
	log.Printf("Server %s listening at %s with %d persistent rooms", strings.TrimSpace(reg.Snapshot().ID), *addr, len(rooms.Directory().Rooms))
	if *cert != "" {
		err = server.ListenAndServeTLS(*cert, *key)
	} else {
		err = server.ListenAndServe()
	}
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

// Diagnostics are opt-in: behind a same-host proxy every public request is loopback.
func routes(rooms, latency http.Handler, diagnostics bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latency":
			latency.ServeHTTP(w, r)
		case "/ws", "/health", "/metrics":
			rooms.ServeHTTP(w, r)
		case "/diagnostics":
			if diagnostics {
				rooms.ServeHTTP(w, r)
				return
			}
			http.NotFound(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}
