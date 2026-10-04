// Package web serves the frontend built for this exact game release.
package web

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:dist
var assets embed.FS

func Handler() http.Handler {
	root, err := fs.Sub(assets, "dist")
	if err != nil {
		panic(err)
	}
	return compressedHandler(root)
}

// Portal templates and scripts are copied by the build, keeping source ownership in frontend.
//
//go:embed portal/*
var portal embed.FS

func PortalSource(name string) string {
	source, err := portal.ReadFile("portal/" + name)
	if err != nil {
		panic(err)
	}
	return string(source)
}
