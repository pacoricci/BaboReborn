// Central is the independently operated account service composition root.
package main

import (
	"context"
	"crypto/rsa"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"baboreborn/backend/central"
	"baboreborn/backend/central/storage"
	"baboreborn/backend/compatibility"
	"baboreborn/backend/content"
	"baboreborn/backend/identity"
	"baboreborn/backend/internal/persistence"
	"baboreborn/backend/registry"
	"baboreborn/backend/web"
	bundledcontent "baboreborn/content"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() (err error) {
	directory := flag.String("data-dir", ".data/central", "Private central data and backup directory")
	addr := flag.String("addr", "127.0.0.1:8090", "Loopback HTTP address for development")
	operation := flag.String("storage", "serve", "serve, initialize, backup or restore")
	file := flag.String("backup-file", "", "Backup source/destination")
	origin := flag.String("origin", "http://127.0.0.1:8090", "Public central origin")
	development := flag.Bool("development", false, "Allow loopback HTTP development")
	cert := flag.String("tls-cert", "", "TLS certificate")
	key := flag.String("tls-key", "", "TLS key")
	signing := flag.String("signing-key", "", "PKCS8 RSA key file; defaults to data-dir/signing.pem")
	public := flag.String("public-keys", "", "Public JWKS file; defaults to data-dir/keys.json")
	kid := flag.String("key-id", "initial", "Active signing key ID")
	contentDir := flag.String("content-dir", "", "Additional central maps, skins and themes")
	fileOrigin := flag.String("content-origin", "", "Public CDN origin for immutable content; empty serves directly")
	flag.Parse()
	if *signing == "" {
		*signing = filepath.Join(*directory, "signing.pem")
	}
	if *public == "" {
		*public = filepath.Join(*directory, "keys.json")
	}
	if *operation == "keygen" {
		lease, err := persistence.Acquire(*directory)
		if err != nil {
			return err
		}
		defer func() {
			if e := lease.Close(); err == nil {
				err = e
			}
		}()
		return identity.GenerateKey(*signing, *public, *kid)
	}

	if *operation != "serve" && *operation != "initialize" && *operation != "backup" && *operation != "restore" {
		return fmt.Errorf("unknown storage operation")
	}
	if (*operation == "backup" || *operation == "restore") && *file == "" {
		return fmt.Errorf("backup-file is required")
	}
	if (*cert == "") != (*key == "") {
		return fmt.Errorf("tls-cert and tls-key are required together")
	}
	if *operation == "serve" {
		canonical, err := identity.CanonicalOrigin(*origin, *development)
		if err != nil {
			return err
		}
		*origin = canonical
		if !*development && *cert == "" {
			return fmt.Errorf("TLS certificate required for public serving")
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	start, end := context.WithTimeout(ctx, 30*time.Second)
	c, err := storage.OpenCentral(start, *directory, os.Getenv("CENTRAL_DATABASE_URL"), *operation == "serve" || *operation == "initialize")
	end()
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := c.Close(); err == nil {
			err = closeErr
		}
	}()
	switch *operation {
	case "initialize":
		return nil
	case "backup":
		return c.Backup(ctx, *file)
	case "restore":
		return c.Restore(ctx, *file)
	}
	signer, err := identity.LoadSigner(*signing, *kid, strings.TrimRight(*origin, "/"))
	if err != nil {
		return err
	}
	keys, err := identity.LoadKeys(*public)
	if err != nil {
		return err
	}
	matching := keys.Key(*kid)
	if len(matching) != 1 || !matching[0].Key.(*rsa.PublicKey).Equal(signer.Public.Key) {
		return fmt.Errorf("active signing key must be published in public keys")
	}
	cosmetics, err := content.Load(bundledcontent.Files, *contentDir)
	if err != nil {
		return err
	}
	if err = cosmetics.SetFileOrigin(*fileOrigin, *development); err != nil {
		return err
	}
	service := &central.Service{DB: c.DB, Signer: signer, Keys: keys, Origin: strings.TrimRight(*origin, "/"), Development: *development, Files: web.Handler(), Content: cosmetics, VerifierRegistry: registry.NewVerifier(strings.TrimRight(*origin, "/"), *development, compatibility.Current())}
	clientID, clientSecret := os.Getenv("GOOGLE_CLIENT_ID"), os.Getenv("GOOGLE_CLIENT_SECRET")
	if (clientID == "") != (clientSecret == "") {
		return fmt.Errorf("both Google credentials are required")
	}
	if clientID != "" {
		provider, err := oidc.NewProvider(oidc.ClientContext(ctx, &http.Client{Timeout: 10 * time.Second}), "https://accounts.google.com")
		if err != nil {
			return fmt.Errorf("google discovery unavailable")
		}
		service.OAuth = oauth2.Config{ClientID: clientID, ClientSecret: clientSecret, Endpoint: provider.Endpoint(), RedirectURL: service.Origin + "/auth/callback", Scopes: []string{oidc.ScopeOpenID}}
		service.Verifier = provider.Verifier(&oidc.Config{ClientID: clientID, SupportedSigningAlgs: []string{"RS256"}})
	}
	cleanupCtx, stopCleanup := context.WithCancel(ctx)
	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		service.RunCleanup(cleanupCtx)
	}()
	defer func() {
		stopCleanup()
		<-cleanupDone
	}()
	s := &http.Server{Addr: *addr, Handler: service.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		timeout, done := context.WithTimeout(context.Background(), 3*time.Second)
		defer done()
		if err := s.Shutdown(timeout); err != nil {
			log.Printf("HTTP shutdown: %v", err)
		}
	}()
	log.Printf("Portal identity v1 ready on %s", *addr)
	if *cert != "" {
		err = s.ListenAndServeTLS(*cert, *key)
	} else {
		err = s.ListenAndServe()
	}
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
