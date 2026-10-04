// Package release describes the product release independently of compatibility.
package release

import (
	"regexp"
	"strings"
)

// Version is populated from package.json by the supported build workflows.
// Direct go builds remain explicitly unknown rather than claiming a release.
var Version = "dev"

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

// Stable accepts release versions without suffixes, including initial 0.x releases.
func Stable(version string) bool { return len(version) <= 64 && stableVersion.MatchString(version) }

func Older(installed, recommended string) bool {
	if !Stable(installed) || !Stable(recommended) {
		return false
	}
	a, b := strings.Split(installed, "."), strings.Split(recommended, ".")
	for i := range a {
		if len(a[i]) != len(b[i]) {
			return len(a[i]) < len(b[i])
		}
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func Notes(version string) string {
	if !Stable(version) {
		return ""
	}
	return "https://github.com/pacoricci/BaboReborn/releases/tag/v" + version
}
