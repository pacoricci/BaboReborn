// Command release-version reads the single product version source for Go builds.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"baboreborn/backend/release"
)

func main() {
	data, err := os.ReadFile("package.json")
	var manifest struct {
		Version string `json:"version"`
	}
	if err != nil || json.Unmarshal(data, &manifest) != nil || !release.Stable(manifest.Version) {
		fmt.Fprintln(os.Stderr, "package.json must contain a stable release version")
		os.Exit(1)
	}
	fmt.Print(manifest.Version)
}
