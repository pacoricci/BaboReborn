package release

import "testing"

func TestReleaseOrderingOnlyComparesStableVersions(t *testing.T) {
	for _, tc := range []struct {
		installed, recommended string
		older                  bool
	}{
		{"0.1.0", "0.2.0", true}, {"0.9.0", "1.0.0", true},
		{"0.2.0", "0.1.0", false}, {"0.1.0", "0.1.0", false},
		{"1.9.0", "1.10.0", true}, {"1.10.0", "1.9.0", false},
		{"1.0.9", "1.0.10", true}, {"1.0.0", "2.0.0", true},
		{"2.0.0", "2.0.0", false}, {"3.0.0", "2.0.0", false},
		{"", "2.0.0", false}, {"dev", "2.0.0", false},
		{"1.0.0-custom", "2.0.0", false}, {"1.0.0", "dev", false},
		{"01.0.0", "2.0.0", false}, {"1.0", "2.0.0", false},
	} {
		if got := Older(tc.installed, tc.recommended); got != tc.older {
			t.Errorf("Older(%q, %q) = %v", tc.installed, tc.recommended, got)
		}
	}
	if Notes("dev") != "" || Notes("2.0.0") != "https://github.com/pacoricci/BaboReborn/releases/tag/v2.0.0" {
		t.Fatal("invalid release notes target")
	}
}

func TestInitialReleaseVersion(t *testing.T) {
	if !Stable("0.1.0") || Notes("0.1.0") != "https://github.com/pacoricci/BaboReborn/releases/tag/v0.1.0" {
		t.Fatal("initial release must be recognized and have release notes")
	}
	for _, version := range []string{"00.1.0", "0.01.0", "0.1.00", "0.1.0-alpha.1", "0.1.0+build"} {
		if Stable(version) {
			t.Errorf("accepted invalid release %q", version)
		}
	}
}
