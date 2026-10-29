// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package unfurl fetches link preview metadata on behalf of clients.
//
// Why the server does this at all: in an encrypted channel the client
// could fetch previews itself, but that reveals every reader's IP address
// to every site anyone links. Routing it through the server means the
// server learns which URLs are shared while readers stay anonymous to the
// linked site. Neither option is clean; this is the less bad one, and it
// is recorded as a known tension in docs/decisions.md.
//
// Fetching arbitrary user-supplied URLs from inside the server is a
// server-side request forgery primitive if done naively. Everything in
// here exists to stop that.
package unfurl

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/html"
)

const (
	fetchTimeout = 8 * time.Second

	// Enough for the <head> of any reasonable page. Preview metadata lives
	// near the top, so there is no reason to read a whole document.
	maxBodyBytes = 512 * 1024

	maxRedirects = 3

	cacheTTL     = 6 * time.Hour
	cacheMaxKeys = 5000
)

var (
	ErrBlocked   = errors.New("unfurl: destination not allowed")
	ErrNotHTML   = errors.New("unfurl: response is not HTML")
	ErrBadScheme = errors.New("unfurl: only http and https are supported")
)

// Preview is what a client renders. Every field is optional; a page with
// no metadata yields a result with just the URL and whatever title exists.
type Preview struct {
	URL         string `json:"url"`
	Site        string `json:"site,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
}

type cacheEntry struct {
	preview Preview
	expires time.Time
}

type Fetcher struct {
	client *http.Client

	mu    sync.Mutex
	cache map[string]cacheEntry
}

func New() *Fetcher {
	f := &Fetcher{cache: make(map[string]cacheEntry)}

	dialer := &net.Dialer{Timeout: 5 * time.Second}

	f.client = &http.Client{
		Timeout: fetchTimeout,
		Transport: &http.Transport{
			// The check happens here, after DNS resolution and
			// immediately before the connection is made. Validating the
			// hostname earlier would be defeated by a DNS record that
			// resolves to a private address, or by one that answers
			// differently on a second lookup.
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, _, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				ip := net.ParseIP(host)
				if ip == nil || !isPublic(ip) {
					return nil, ErrBlocked
				}
				return dialer.DialContext(ctx, network, addr)
			},
			DisableKeepAlives: true,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("unfurl: too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return ErrBadScheme
			}
			return nil
		},
	}

	return f
}

// isPublic reports whether an address is one we are willing to connect to.
//
// Everything internal is refused: loopback, private ranges, link-local
// (which includes cloud metadata endpoints at 169.254.169.254),
// multicast, and unspecified. Without this, any user could make the
// server fetch its own admin endpoints, other services on the host
// network, or cloud credentials.
func isPublic(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() ||
		ip.IsUnspecified() {
		return false
	}

	// Carrier-grade NAT, reserved for provider infrastructure.
	if ip4 := ip.To4(); ip4 != nil {
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return false
		}
		// 0.0.0.0/8 and the 240.0.0.0/4 reserved block.
		if ip4[0] == 0 || ip4[0] >= 240 {
			return false
		}
	}

	return true
}

// Fetch returns preview metadata for raw, using a cached result when one
// is still fresh.
func (f *Fetcher) Fetch(ctx context.Context, raw string) (Preview, error) {
	target, err := url.Parse(raw)
	if err != nil {
		return Preview{}, err
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return Preview{}, ErrBadScheme
	}

	canonical := target.String()

	if p, ok := f.cached(canonical); ok {
		return p, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, canonical, nil)
	if err != nil {
		return Preview{}, err
	}

	// Identify honestly. Pretending to be a browser to bypass a site's
	// preferences would be the wrong instinct for this project.
	req.Header.Set("User-Agent", "OpenVoxa/0.1 (+https://github.com/OpenVoxa/OpenVoxa) link-preview")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := f.client.Do(req)
	if err != nil {
		return Preview{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Preview{}, fmt.Errorf("unfurl: upstream returned %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "html") {
		return Preview{}, ErrNotHTML
	}

	preview := Preview{URL: canonical, Site: target.Hostname()}
	parseMeta(io.LimitReader(resp.Body, maxBodyBytes), &preview, target)

	f.store(canonical, preview)
	return preview, nil
}

func (f *Fetcher) cached(key string) (Preview, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()

	entry, ok := f.cache[key]
	if !ok || time.Now().After(entry.expires) {
		return Preview{}, false
	}
	return entry.preview, true
}

func (f *Fetcher) store(key string, p Preview) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if len(f.cache) >= cacheMaxKeys {
		now := time.Now()
		for k, v := range f.cache {
			if now.After(v.expires) {
				delete(f.cache, k)
			}
		}
		// Still full of live entries: drop arbitrary ones rather than
		// letting the map grow without bound.
		for k := range f.cache {
			if len(f.cache) < cacheMaxKeys {
				break
			}
			delete(f.cache, k)
		}
	}

	f.cache[key] = cacheEntry{preview: p, expires: time.Now().Add(cacheTTL)}
}

// parseMeta walks the document for OpenGraph tags, falling back to the
// plain title and description. Parsing stops at </head>, since nothing
// below it matters here.
func parseMeta(r io.Reader, p *Preview, base *url.URL) {
	tokenizer := html.NewTokenizer(r)

	for {
		switch tokenizer.Next() {
		case html.ErrorToken:
			return

		case html.EndTagToken:
			if name, _ := tokenizer.TagName(); string(name) == "head" {
				return
			}

		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := tokenizer.TagName()

			if string(name) == "title" && p.Title == "" {
				if tokenizer.Next() == html.TextToken {
					p.Title = strings.TrimSpace(string(tokenizer.Text()))
				}
				continue
			}

			if string(name) != "meta" || !hasAttr {
				continue
			}

			var property, content string
			for {
				key, val, more := tokenizer.TagAttr()
				switch strings.ToLower(string(key)) {
				case "property", "name":
					property = strings.ToLower(string(val))
				case "content":
					content = string(val)
				}
				if !more {
					break
				}
			}

			switch property {
			case "og:title", "twitter:title":
				p.Title = content
			case "og:description", "twitter:description", "description":
				if p.Description == "" {
					p.Description = content
				}
			case "og:image", "twitter:image":
				if p.Image == "" {
					p.Image = absolute(base, content)
				}
			case "og:site_name":
				p.Site = content
			}
		}
	}
}

// absolute resolves a possibly relative image URL, and refuses anything
// that is not http or https so a data: or javascript: URL cannot reach a
// client.
func absolute(base *url.URL, ref string) string {
	u, err := url.Parse(ref)
	if err != nil {
		return ""
	}
	resolved := base.ResolveReference(u)
	if resolved.Scheme != "http" && resolved.Scheme != "https" {
		return ""
	}
	return resolved.String()
}
