// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestMeasureUpload(t *testing.T) {
	uploadTestWarmup, uploadTestMeasure = 200*time.Millisecond, 800*time.Millisecond
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Cf-Ray", "a5506fee28e928bb-IAD")
	}))
	defer srv.Close()

	mbps, site, err := measureUpload(context.Background(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if mbps <= 0 {
		t.Errorf("mbps = %v, want > 0", mbps)
	}
	if site != "IAD" {
		t.Errorf("site = %q, want IAD", site)
	}

	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusForbidden)
	}))
	defer bad.Close()
	if _, _, err := measureUpload(context.Background(), bad.URL); err == nil {
		t.Error("a refusing site gave no error")
	}
}
