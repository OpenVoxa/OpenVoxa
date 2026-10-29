// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package gif talks to a GIF search provider on the server's behalf.
//
// Clients never contact the provider. They ask this server, which asks
// Giphy or Tenor and proxies the images back. Without that, every user's
// address lands in a third party's logs for every GIF anyone browses,
// which is the kind of quiet leak this project exists to avoid.
//
// The server still learns what people search for, which is the same
// tradeoff link previews make. Neither provider is privacy-clean, so the
// honest position is to document it and let operators turn the feature
// off entirely.
package gif

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var (
	ErrDisabled   = errors.New("gif: no provider configured")
	ErrBadHost    = errors.New("gif: media host not allowed")
	ErrNoResults  = errors.New("gif: not found")
	errBadRequest = errors.New("gif: provider rejected the request")
)

// Result is the shape clients see, identical whichever provider is in use.
type Result struct {
	ID          string `json:"id"`
	Description string `json:"description"`

	// Small animated preview for the picker grid.
	PreviewURL string `json:"-"`
	// Full-size version, downloaded when a user actually picks one.
	FullURL string `json:"-"`

	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
}

// Client fetches from whichever provider the operator configured.
type Client struct {
	provider string
	apiKey   string
	http     *http.Client
}

// Attribution is the credit line a provider's terms require. Both of them
// do require one, so it is surfaced rather than quietly skipped.
func (c *Client) Attribution() string {
	switch c.provider {
	case "giphy":
		return "Powered by GIPHY"
	case "tenor":
		return "Powered by Tenor"
	}
	return ""
}

func (c *Client) Provider() string { return c.provider }
func (c *Client) Enabled() bool    { return c.provider != "" && c.apiKey != "" }

func New(provider, apiKey string) *Client {
	return &Client{
		provider: strings.ToLower(strings.TrimSpace(provider)),
		apiKey:   apiKey,
		http:     &http.Client{Timeout: 10 * time.Second},
	}
}

// mediaHosts limits what the media proxy will fetch. The proxy takes a URL
// that came from a provider response, and a response is still remote input:
// without this, a compromised or hostile provider could point us at
// anything.
var mediaHosts = map[string]bool{
	"media.giphy.com":   true,
	"media0.giphy.com":  true,
	"media1.giphy.com":  true,
	"media2.giphy.com":  true,
	"media3.giphy.com":  true,
	"media4.giphy.com":  true,
	"i.giphy.com":       true,
	"media.tenor.com":   true,
	"c.tenor.com":       true,
	"media1.tenor.com":  true,
	"tenor.googleapis.com": true,
}

// AllowedMediaHost reports whether a URL may be fetched by the proxy.
func AllowedMediaHost(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return false
	}
	return mediaHosts[u.Hostname()]
}

// Search returns results for a query, or trending content when query is
// empty.
func (c *Client) Search(ctx context.Context, query string, limit int) ([]Result, error) {
	if !c.Enabled() {
		return nil, ErrDisabled
	}
	if limit <= 0 || limit > 50 {
		limit = 24
	}

	switch c.provider {
	case "giphy":
		return c.searchGiphy(ctx, query, limit)
	case "tenor":
		return c.searchTenor(ctx, query, limit)
	}
	return nil, ErrDisabled
}

func (c *Client) get(ctx context.Context, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "OpenVoxa/0.1 (+https://github.com/OpenVoxa/OpenVoxa)")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: status %d", errBadRequest, resp.StatusCode)
	}

	// Providers are not supposed to send us megabytes of JSON, and a
	// mistake on their end should not become a memory problem on ours.
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
}

type giphyResponse struct {
	Data []struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Images struct {
			FixedHeightSmall struct {
				URL    string `json:"url"`
				Width  string `json:"width"`
				Height string `json:"height"`
			} `json:"fixed_height_small"`
			Original struct {
				URL string `json:"url"`
			} `json:"original"`
			Downsized struct {
				URL string `json:"url"`
			} `json:"downsized"`
		} `json:"images"`
	} `json:"data"`
}

func (c *Client) searchGiphy(ctx context.Context, query string, limit int) ([]Result, error) {
	q := url.Values{}
	q.Set("api_key", c.apiKey)
	q.Set("limit", strconv.Itoa(limit))
	// Force the tamest content rating the API offers. An operator who
	// wants otherwise can patch it, but the default should not surprise
	// anyone running this for a family or a small community.
	q.Set("rating", "g")
	q.Set("bundle", "messaging_non_clips")

	path := "trending"
	if query != "" {
		path = "search"
		q.Set("q", query)
	}

	var body giphyResponse
	if err := c.get(ctx, "https://api.giphy.com/v1/gifs/"+path+"?"+q.Encode(), &body); err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(body.Data))
	for _, item := range body.Data {
		preview := item.Images.FixedHeightSmall.URL
		full := item.Images.Downsized.URL
		if full == "" {
			full = item.Images.Original.URL
		}
		if preview == "" || full == "" {
			continue
		}

		w, _ := strconv.Atoi(item.Images.FixedHeightSmall.Width)
		h, _ := strconv.Atoi(item.Images.FixedHeightSmall.Height)

		results = append(results, Result{
			ID:          item.ID,
			Description: item.Title,
			PreviewURL:  preview,
			FullURL:     full,
			Width:       w,
			Height:      h,
		})
	}

	return results, nil
}

type tenorResponse struct {
	Results []struct {
		ID           string `json:"id"`
		Description  string `json:"content_description"`
		MediaFormats map[string]struct {
			URL  string `json:"url"`
			Dims []int  `json:"dims"`
		} `json:"media_formats"`
	} `json:"results"`
}

func (c *Client) searchTenor(ctx context.Context, query string, limit int) ([]Result, error) {
	q := url.Values{}
	q.Set("key", c.apiKey)
	q.Set("limit", strconv.Itoa(limit))
	q.Set("contentfilter", "high")
	q.Set("media_filter", "tinygif,gif")
	q.Set("client_key", "openvoxa")

	path := "featured"
	if query != "" {
		path = "search"
		q.Set("q", query)
	}

	var body tenorResponse
	if err := c.get(ctx, "https://tenor.googleapis.com/v2/"+path+"?"+q.Encode(), &body); err != nil {
		return nil, err
	}

	results := make([]Result, 0, len(body.Results))
	for _, item := range body.Results {
		preview := item.MediaFormats["tinygif"]
		full := item.MediaFormats["gif"]
		if preview.URL == "" || full.URL == "" {
			continue
		}

		r := Result{
			ID:          item.ID,
			Description: item.Description,
			PreviewURL:  preview.URL,
			FullURL:     full.URL,
		}
		if len(preview.Dims) == 2 {
			r.Width, r.Height = preview.Dims[0], preview.Dims[1]
		}

		results = append(results, r)
	}

	return results, nil
}

// FetchMedia streams a provider image, for the proxy and for downloading a
// chosen GIF. The host check is the reason this is a method rather than a
// bare http.Get.
func (c *Client) FetchMedia(ctx context.Context, raw string) (io.ReadCloser, string, error) {
	if !AllowedMediaHost(raw) {
		return nil, "", ErrBadHost
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "OpenVoxa/0.1 (+https://github.com/OpenVoxa/OpenVoxa)")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, "", fmt.Errorf("%w: status %d", errBadRequest, resp.StatusCode)
	}

	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		resp.Body.Close()
		return nil, "", fmt.Errorf("%w: not an image", errBadRequest)
	}

	return resp.Body, contentType, nil
}
