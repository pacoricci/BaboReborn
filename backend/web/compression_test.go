package web

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestPrecompressedAssets(t *testing.T) {
	original := []byte("a model with repeated vertices and exact original bytes")
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(original); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	handler := compressedHandler(fstest.MapFS{"model.glb": {Data: original}, "model.glb.gz": {Data: compressed.Bytes()}})
	for _, encoding := range []string{"gzip", "br, gzip;q=0.8", "*", "gzip;q=0, *;q=1", "br", "gzip;q=invalid", ""} {
		t.Run(encoding, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/model.glb", nil)
			req.Header.Set("Accept-Encoding", encoding)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			body := response.Body.Bytes()
			wantCompressed := encoding == "gzip" || encoding == "br, gzip;q=0.8" || encoding == "*"
			if (response.Header().Get("Content-Encoding") == "gzip") != wantCompressed {
				t.Fatal(response.Header())
			}
			if wantCompressed {
				reader, err := gzip.NewReader(bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				body, err = io.ReadAll(reader)
				if err != nil {
					t.Fatal(err)
				}
				if err := reader.Close(); err != nil {
					t.Fatal(err)
				}
			}
			if response.Code != 200 || !bytes.Equal(body, original) || response.Header().Get("Vary") != "Accept-Encoding" {
				t.Fatal(response)
			}
		})
	}
	for _, method := range []string{"HEAD", "GET"} {
		req := httptest.NewRequest(method, "/model.glb", nil)
		req.Header.Set("Accept-Encoding", "gzip")
		if method == "GET" {
			req.Header.Set("Range", "bytes=0-3")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if method == "HEAD" {
			if response.Code != 200 || response.Body.Len() != 0 || response.Header().Get("Content-Encoding") != "gzip" {
				t.Fatal(response)
			}
		} else if response.Code != 206 || response.Body.String() != string(original[:4]) || response.Header().Get("Content-Encoding") != "" {
			t.Fatal(response)
		}
	}
}
