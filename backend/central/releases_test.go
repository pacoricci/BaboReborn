package central

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"baboreborn/backend/compatibility"
	"baboreborn/backend/registry"
	"baboreborn/backend/release"
)

func recommendedRelease(t *testing.T) {
	t.Helper()
	previous := release.Version
	release.Version = "2.0.0"
	t.Cleanup(func() { release.Version = previous })
}

func TestReleaseAdviceSeparatesVersionContractsAndFreshness(t *testing.T) {
	recommendedRelease(t)
	now := time.Now().UTC()
	expected := compatibility.Current()
	s := &Service{VerifierRegistry: registry.NewVerifier("https://central.example", false, expected), Now: func() time.Time { return now }}
	d := registry.Descriptor{ID: "server", PublicKey: "key", Origin: "https://game.example"}
	for _, tc := range []struct {
		version  string
		mismatch bool
		status   string
	}{
		{"1.0.0", false, "update_available"}, {"1.0.0", true, "update_required"},
		{"2.0.0", false, "current"}, {"2.0.0", true, "incompatible"},
		{"3.0.0", false, "compatible"}, {"3.0.0", true, "incompatible"},
		{"", false, "compatible"}, {"", true, "incompatible"},
		{"dev", false, "compatible"}, {"1.0.0-custom", true, "incompatible"},
	} {
		probe := registry.Probe{Release: tc.version, Compatibility: expected}
		if tc.mismatch {
			probe.Compatibility.Protocol++
			probe.Compatibility.Profile = "custom"
		}
		s.observeRelease(d.ID, d.PublicKey, d.Origin, &probe, now)
		got := s.serverRelease(d)
		if got.Status != tc.status || got.Installed != tc.version || got.Recommended != "2.0.0" || got.CheckedAt == nil || !got.CheckedAt.Equal(now) {
			t.Fatalf("%+v: %+v", tc, got)
		}
		if tc.mismatch {
			if len(got.Differences) != 2 || got.Differences[0].Contract != "protocol" || got.Differences[0].Expected != "1" || got.Differences[0].Received != "2" || got.Differences[1].Contract != "profile" {
				t.Fatal(got.Differences)
			}
		} else if len(got.Differences) != 0 {
			t.Fatal(got.Differences)
		}
	}
	now = now.Add(registry.Presence)
	if got := s.serverRelease(d); got.Status != "unknown" || len(got.Differences) != 0 {
		t.Fatal("stale verdict", got)
	}
	probe := registry.Probe{Release: "1.0.0", Compatibility: expected}
	s.observeRelease(d.ID, d.PublicKey, d.Origin, &probe, now)
	s.VerifierRegistry.Expected.API++
	if got := s.serverRelease(d); got.Status != "unknown" {
		t.Fatal("central contract changed", got)
	}
	s.VerifierRegistry.Expected = expected
	for _, changed := range []registry.Descriptor{
		{ID: d.ID, PublicKey: "other", Origin: d.Origin},
		{ID: d.ID, PublicKey: d.PublicKey, Origin: "https://other.example"},
	} {
		if got := s.serverRelease(changed); got.Status != "unknown" || got.Installed != "" {
			t.Fatal("observation escaped installation", got)
		}
	}
	s.observeRelease(d.ID, d.PublicKey, d.Origin, nil, now)
	if got := s.serverRelease(d); got.Status != "unknown" || got.CheckedAt != nil {
		t.Fatal("failed verification", got)
	}
}

func TestRegistryReleaseAdviceThroughSignedHeartbeat(t *testing.T) {
	recommendedRelease(t)
	s := testService(t)
	s.Development = true
	center := httptest.NewServer(s.Handler())
	defer center.Close()
	s.Origin = center.URL
	s.Signer.Issuer = s.Origin
	s.VerifierRegistry = registry.NewVerifier(s.Origin, true, compatibility.Current())
	// The initial registration does not probe; install the handler before claiming.
	handler := http.NotFoundHandler()
	game := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	defer game.Close()
	cookie, owner := accountCookie(t, s, "release-owner")
	d, code := management(t, s, cookie, "POST", "/api/v1/manage/servers", map[string]string{"name": "Release", "region": "EU", "origin": game.URL})
	installed := makeInstallation(t, s, code)
	installed.client.Release = "1.0.0"
	handler = installed.client.Handler(http.NotFoundHandler())
	ctx := context.Background()
	check := func(status string, listed bool) {
		t.Helper()
		if err := installed.client.Step(ctx); err != nil {
			t.Fatal(err)
		}
		managed, err := s.managementServers(ctx, owner)
		if err != nil || len(managed) != 1 || managed[0].Release.Status != status || managed[0].ID != d.ID {
			t.Fatalf("%s: %+v %v", status, managed, err)
		}
		public, err := s.listServers(ctx, "")
		if err != nil || (len(public) == 1) != listed {
			t.Fatalf("public catalog: %+v %v", public, err)
		}
	}
	check("update_available", true)
	installed.client.Compatibility.API++
	check("update_required", false)
	if installed.client.Snapshot().ID != d.ID {
		t.Fatal("incompatibility lost association")
	}
	installed.client.Release = "3.0.0"
	check("incompatible", false)
	installed.client.Compatibility = compatibility.Current()
	installed.client.Release = ""
	check("compatible", true)
	installed.client.Release = "2.0.0"
	check("current", true)
	s.releaseObservations = nil
	managed, err := s.managementServers(ctx, owner)
	if err != nil || managed[0].Release.Status != "unknown" {
		t.Fatal("restart retained observation", managed, err)
	}
	check("current", true)
}
