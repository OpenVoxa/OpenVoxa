// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// webUI holds the built client-web bundle. The repository only carries a
// placeholder index.html; the Dockerfile copies client-web/dist over it
// before `go build`. "all:" keeps files whose names start with "." or "_",
// which bundlers sometimes emit.
//
//go:embed all:webui
var webUI embed.FS

// webAppHandler serves the web client at the site root.
//
// It is a single-page app: any path that is not a real file gets
// index.html, so a reload on a client-side route still loads the app.
// Paths under /api/ never fall back, so a mistyped API call answers 404
// rather than an HTML page the client would fail to parse.
//
// Vite puts content-hashed files under assets/, which can be cached
// forever. index.html must never be cached, or a browser keeps loading
// the previous build's asset names after an update.
func webAppHandler() http.Handler {
	sub, err := fs.Sub(webUI, "webui")
	if err != nil {
		// Embedded at compile time, so a failure here is a build problem.
		panic(err)
	}
	files := http.FileServerFS(sub)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "api" || strings.HasPrefix(name, "api/") {
			http.NotFound(w, r)
			return
		}

		if name != "" && name != "index.html" {
			if st, err := fs.Stat(sub, name); err == nil && !st.IsDir() {
				if strings.HasPrefix(name, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}

		// Everything else is the app itself. (A request for /index.html
		// itself gets redirected to /, which is fine.)
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, r, sub, "index.html")
	})
}
