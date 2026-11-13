// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"log/slog"
	"net/http"
	"strconv"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

// The installable web app (decisions.md Feature decisions, "Planned:
// installable web app (PWA)"). A browser offers to install a site as an app when it
// finds a web app manifest: a small JSON file naming the app, its icons
// and how it opens. The server builds it per request from the name and
// icon in Server settings, so every server installs as its own app with
// its own name and icon.
//
// Icons have to be PNG to be safe everywhere: Safari's home-screen icon
// (apple-touch-icon) and some Android launchers don't take WebP, and the
// server icon is usually WebP (the administrator's browser encodes it).
// So the server decodes it and serves it again as a PNG at the sizes the
// manifest names. Without a server icon, the OpenVoxa icon that ships with
// the web client (client-web/public/icons) is used.

// The app's background and title bar colour: --bg in styles.css, also the
// colour of the hexagon in the OpenVoxa icon.
const appColour = "#333333"

var appBackground = color.RGBA{0x33, 0x33, 0x33, 0xff}

// appIconSizes are the sizes /api/v1/app-icon serves: 192 and 512 are
// what Chrome and Android ask for, 180 is the iPhone home screen.
var appIconSizes = map[int]bool{180: true, 192: true, 512: true}

type manifestIcon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type"`
	Purpose string `json:"purpose,omitempty"`
}

type webManifest struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	ShortName       string         `json:"short_name"`
	Description     string         `json:"description"`
	StartURL        string         `json:"start_url"`
	Scope           string         `json:"scope"`
	Display         string         `json:"display"`
	BackgroundColor string         `json:"background_color"`
	ThemeColor      string         `json:"theme_color"`
	Icons           []manifestIcon `json:"icons"`
}

// getManifest: public, like the server's name and icon. Never cached, so a
// new name or icon reaches the next install (an installed app picks it up
// when the browser next checks, which can take a day or more).
func (a *API) getManifest(w http.ResponseWriter, r *http.Request) {
	var (
		name    string
		hasIcon bool
		version int
	)
	if err := a.pool.QueryRow(r.Context(),
		`SELECT server_name, icon IS NOT NULL, icon_version FROM server_settings`,
	).Scan(&name, &hasIcon, &version); err != nil {
		slog.Error("loading server info for the manifest", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load the server info")
		return
	}
	if name == "" {
		name = "OpenVoxa"
	}

	m := webManifest{
		// The id keeps an installed app the same app if start_url ever changes.
		ID:              "/",
		Name:            name,
		ShortName:       name,
		Description:     "Text channels, voice and screen share on " + name + ".",
		StartURL:        "/",
		Scope:           "/",
		Display:         "standalone",
		BackgroundColor: appColour,
		ThemeColor:      appColour,
	}
	if hasIcon {
		v := strconv.Itoa(version)
		for _, s := range []string{"192", "512"} {
			m.Icons = append(m.Icons, manifestIcon{
				Src: "/api/v1/app-icon?size=" + s + "&v=" + v, Sizes: s + "x" + s, Type: "image/png",
			})
		}
	} else {
		m.Icons = []manifestIcon{
			{Src: "/icons/icon-192.png", Sizes: "192x192", Type: "image/png"},
			{Src: "/icons/icon-512.png", Sizes: "512x512", Type: "image/png"},
			// Android crops icons to its own shape (circle, squircle...);
			// this one is padded on the hexagon's colour so nothing is cut.
			{Src: "/icons/maskable-512.png", Sizes: "512x512", Type: "image/png", Purpose: "maskable"},
		}
	}

	body, err := json.Marshal(m)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not build the manifest")
		return
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
}

// getAppIcon: public. The server icon as a size x size PNG
// (?size=180|192|512). Like /api/v1/server-icon, a URL carrying the
// current version is cached for good.
func (a *API) getAppIcon(w http.ResponseWriter, r *http.Request) {
	size, err := strconv.Atoi(r.URL.Query().Get("size"))
	if err != nil || !appIconSizes[size] {
		writeError(w, http.StatusBadRequest, "size must be 180, 192 or 512")
		return
	}
	img, version, ok := a.loadServerIconImage(w, r)
	if !ok {
		return
	}
	out, err := encodeAppIcon(img, size, false)
	if err != nil {
		slog.Error("encoding the app icon", "err", err)
		writeError(w, http.StatusInternalServerError, "could not convert the icon")
		return
	}
	if r.URL.Query().Get("v") == strconv.Itoa(version) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	writePNG(w, out)
}

// getAppleTouchIcon: public. The iPhone and iPad home-screen icon, at the
// address Safari also tries on its own. iOS shows transparent corners as
// black, so the server icon is laid on the app's background colour; the
// OpenVoxa icon's file already is.
func (a *API) getAppleTouchIcon(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	var hasIcon bool
	if err := a.pool.QueryRow(r.Context(),
		`SELECT icon IS NOT NULL FROM server_settings`,
	).Scan(&hasIcon); err != nil {
		slog.Error("loading server icon", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the icon")
		return
	}
	if !hasIcon {
		data, err := fs.ReadFile(webUI, "webui/icons/apple-touch-icon.png")
		if err != nil {
			// A server built without the web client (development).
			http.NotFound(w, r)
			return
		}
		writePNG(w, data)
		return
	}
	img, _, ok := a.loadServerIconImage(w, r)
	if !ok {
		return
	}
	out, err := encodeAppIcon(img, 180, true)
	if err != nil {
		slog.Error("encoding the apple touch icon", "err", err)
		writeError(w, http.StatusInternalServerError, "could not convert the icon")
		return
	}
	writePNG(w, out)
}

// loadServerIconImage decodes the stored server icon. On failure it has
// already answered the request.
func (a *API) loadServerIconImage(w http.ResponseWriter, r *http.Request) (image.Image, int, bool) {
	var (
		data        []byte
		contentType *string
		version     int
	)
	if err := a.pool.QueryRow(r.Context(),
		`SELECT icon, icon_type, icon_version FROM server_settings`,
	).Scan(&data, &contentType, &version); err != nil {
		slog.Error("loading server icon", "err", err)
		writeError(w, http.StatusInternalServerError, "could not fetch the icon")
		return nil, 0, false
	}
	if data == nil || contentType == nil {
		writeError(w, http.StatusNotFound, "this server has no icon")
		return nil, 0, false
	}
	// The upload already checked the type from the bytes and the size
	// (at most 1024 x 1024), so decoding is bounded.
	var (
		img image.Image
		err error
	)
	switch *contentType {
	case "image/png":
		img, err = png.Decode(bytes.NewReader(data))
	case "image/webp":
		img, err = webp.Decode(bytes.NewReader(data))
	default:
		err = errors.New("unknown icon type")
	}
	if err != nil {
		slog.Error("decoding server icon", "type", *contentType, "err", err)
		writeError(w, http.StatusInternalServerError, "could not read the icon")
		return nil, 0, false
	}
	return img, version, true
}

// encodeAppIcon scales img to size x size (the icon is square) and encodes
// it as PNG, on the app's background colour when opaque is set.
func encodeAppIcon(img image.Image, size int, opaque bool) ([]byte, error) {
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	if opaque {
		draw.Draw(dst, dst.Bounds(), image.NewUniform(appBackground), image.Point{}, draw.Src)
	}
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), draw.Over, nil)
	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writePNG(w http.ResponseWriter, data []byte) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
