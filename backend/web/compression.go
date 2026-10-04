package web

import (
	"bytes"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
)

func acceptsGzip(value string) bool {
	wildcard := false
	for _, entry := range strings.Split(value, ",") {
		parts := strings.Split(entry, ";")
		coding := strings.TrimSpace(parts[0])
		quality := 1.0
		for _, parameter := range parts[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if ok && key == "q" {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || !(parsed >= 0 && parsed <= 1) {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		if strings.EqualFold(coding, "gzip") {
			return quality > 0
		}
		if coding == "*" {
			wildcard = quality > 0
		}
	}
	return wildcard
}

func compressedHandler(root fs.FS) http.Handler {
	fallback := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/")
		if strings.HasSuffix(name, ".gz") {
			http.NotFound(w, r)
			return
		}
		if (r.Method == "GET" || r.Method == "HEAD") && fs.ValidPath(name) {
			if data, err := fs.ReadFile(root, name+".gz"); err == nil {
				w.Header().Add("Vary", "Accept-Encoding")
				// Range offsets describe the original file when the client requests a range.
				if r.Header.Get("Range") == "" && acceptsGzip(r.Header.Get("Accept-Encoding")) {
					contentType := mime.TypeByExtension(path.Ext(name))
					if path.Ext(name) == ".glb" {
						contentType = "model/gltf-binary"
					}
					if contentType == "" {
						contentType = "application/octet-stream"
					}
					w.Header().Set("Content-Type", contentType)
					w.Header().Set("Content-Encoding", "gzip")
					http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
					return
				}
			}
		}
		fallback.ServeHTTP(w, r)
	})
}
