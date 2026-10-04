// Package testcontent reads bundled map fixtures for tests and benchmarks.
package testcontent

import (
	"io/fs"

	"baboreborn/content"
)

func Map(id string) []byte {
	data, err := content.Files.ReadFile("maps/" + id + ".json")
	if err != nil {
		panic(err)
	}
	return data
}

// Maps includes every published bundled map, including newly authored layouts.
func Maps() [][]byte {
	paths, err := fs.Glob(content.Files, "maps/*.json")
	if err != nil {
		panic(err)
	}
	maps := make([][]byte, 0, len(paths))
	for _, path := range paths {
		data, err := content.Files.ReadFile(path)
		if err != nil {
			panic(err)
		}
		maps = append(maps, data)
	}
	return maps
}
