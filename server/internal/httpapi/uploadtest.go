// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Upload speed test of this server (migration 0027; decisions.md Open
// items, "Screen share bitrate ceiling"). The voice server sends one copy
// of a share to each viewer, so the host's upload is what fills; the test
// measures it so Server settings > Voice and Video can suggest a limit.
//
// It has to run here, not in the admin's browser: a browser on the same
// network as the server would measure the LAN.
//
// Test data goes to Cloudflare's speed test (speed.cloudflare.com, the
// same endpoint its own web test uses; Ryan's choice, 2026-11-04). It is
// free, needs no account, has sites close to almost everyone, and does
// not publish results; M-Lab's NDT7 was turned down because it publishes
// every test with the server's IP address. The endpoint is not a
// documented API, so a failure is reported plainly rather than guessed
// around. Only an administrator's click starts a test, one at a time.

// uploadTestURL receives the test data. A variable so tests can point it
// at a local server.
var uploadTestURL = "https://speed.cloudflare.com/__up"

const (
	uploadTestStreams = 6        // one connection can't fill a fast line
	uploadTestChunk   = 25 << 20 // bytes per request
)

// Variables so tests can run a short window.
var (
	uploadTestWarmup  = 2 * time.Second // ignored: connections ramping up
	uploadTestMeasure = 8 * time.Second // counted
)

// uploadTestBusy keeps it to one test at a time across the server.
var uploadTestBusy sync.Mutex

type uploadTestResult struct {
	Mbps *float64   `json:"mbps"`
	At   *time.Time `json:"at"`
	// Cloudflare's site code (e.g. IAD), from its CF-Ray header.
	Site *string `json:"site"`
}

// getUploadTest returns the last result. Administrator (route-level).
func (a *API) getUploadTest(w http.ResponseWriter, r *http.Request) {
	var out uploadTestResult
	if err := a.pool.QueryRow(r.Context(),
		`SELECT upload_test_mbps, upload_test_at, upload_test_site FROM server_settings`).
		Scan(&out.Mbps, &out.At, &out.Site); err != nil {
		slog.Error("reading upload test", "err", err)
		writeError(w, http.StatusInternalServerError, "could not load the last test")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// runUploadTest measures the upload for about ten seconds, saves and
// returns the result. Administrator (route-level).
func (a *API) runUploadTest(w http.ResponseWriter, r *http.Request) {
	actor := sessionFrom(r.Context())
	if !uploadTestBusy.TryLock() {
		writeError(w, http.StatusConflict, "a test is already running")
		return
	}
	defer uploadTestBusy.Unlock()

	mbps, site, err := measureUpload(r.Context(), uploadTestURL)
	if err != nil {
		slog.Warn("upload test failed", "err", err, "actor_id", actor.UserID)
		writeError(w, http.StatusBadGateway, "the speed test didn't work: "+err.Error())
		return
	}
	now := time.Now().UTC()
	var sitePtr *string
	if site != "" {
		sitePtr = &site
	}
	if _, err := a.pool.Exec(r.Context(),
		`UPDATE server_settings SET upload_test_mbps = $1, upload_test_at = $2, upload_test_site = $3`,
		mbps, now, sitePtr); err != nil {
		slog.Error("saving upload test", "err", err)
		writeError(w, http.StatusInternalServerError, "could not save the result")
		return
	}
	slog.Info("upload test", "actor_id", actor.UserID, "mbps", int(mbps), "site", site)
	writeJSON(w, http.StatusOK, uploadTestResult{Mbps: &mbps, At: &now, Site: sitePtr})
}

// zeros is an endless source of zero bytes.
type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// counting adds every byte the HTTP client reads from it to n. Bytes read
// are bytes handed to the socket; the kernel's send buffer (a few MB) is
// small next to what a test sends, so it barely skews the result.
type counting struct {
	r io.Reader
	n *atomic.Int64
}

func (c counting) Read(p []byte) (int, error) {
	k, err := c.r.Read(p)
	c.n.Add(int64(k))
	return k, err
}

// measureUpload posts zeros to url over several connections for the
// warmup plus the measured window and returns megabits per second over
// the measured window, and the Cloudflare site that answered.
func measureUpload(parent context.Context, url string) (float64, string, error) {
	ctx, cancel := context.WithTimeout(parent, uploadTestWarmup+uploadTestMeasure)
	defer cancel()

	// HTTP/1.1 only: HTTP/2 would carry every stream on one connection.
	tr := &http.Transport{
		Proxy:             http.ProxyFromEnvironment,
		ForceAttemptHTTP2: false,
		TLSNextProto:      map[string]func(string, *tls.Conn) http.RoundTripper{},
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr}

	var sent atomic.Int64
	var site atomic.Value
	var lastErr atomic.Value
	var wg sync.WaitGroup
	for range uploadTestStreams {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				body := counting{r: io.LimitReader(zeros{}, uploadTestChunk), n: &sent}
				req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
				if err != nil {
					lastErr.Store(err)
					return
				}
				req.ContentLength = uploadTestChunk
				req.Header.Set("Content-Type", "application/octet-stream")
				res, err := client.Do(req)
				if err != nil {
					if ctx.Err() == nil {
						lastErr.Store(err)
						time.Sleep(200 * time.Millisecond)
					}
					continue
				}
				io.Copy(io.Discard, res.Body)
				res.Body.Close()
				if res.StatusCode != http.StatusOK {
					lastErr.Store(errors.New("the test site answered " + res.Status))
					return
				}
				if ray := res.Header.Get("Cf-Ray"); ray != "" {
					if i := strings.LastIndexByte(ray, '-'); i >= 0 {
						site.Store(ray[i+1:])
					}
				}
			}
		}()
	}

	// Count from the end of the warmup to the end of the window.
	var start int64
	select {
	case <-time.After(uploadTestWarmup):
		start = sent.Load()
	case <-ctx.Done():
	}
	t0 := time.Now()
	<-ctx.Done()
	bytes := sent.Load() - start
	elapsed := time.Since(t0)
	wg.Wait()

	if parent.Err() != nil {
		return 0, "", parent.Err()
	}
	if bytes <= 0 || elapsed <= 0 {
		if e, ok := lastErr.Load().(error); ok {
			return 0, "", e
		}
		return 0, "", errors.New("nothing could be sent")
	}
	s, _ := site.Load().(string)
	return float64(bytes) * 8 / elapsed.Seconds() / 1e6, s, nil
}
