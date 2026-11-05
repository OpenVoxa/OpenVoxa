// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"sync"
)

// The server's version, for the About tab (decisions.md Feature
// decisions, "About tab in Settings"). The Docker build writes it to
// versionFile from git: the commit, its date, and whether the source
// built differed from that commit (built before committing, as on a
// development host). A server built any other way reports "unknown".
//
// Staff only: an exact version tells an attacker which known bugs apply.
// The web client is embedded in the server, so this is its version too.

const versionFile = "/openvoxa-version.json"

type serverVersion struct {
	Commit string `json:"commit"`
	Date   string `json:"date"` // ISO 8601, the commit's date
	Dirty  bool   `json:"dirty"`
}

var loadVersion = sync.OnceValue(func() serverVersion {
	v := serverVersion{Commit: "unknown"}
	if b, err := os.ReadFile(versionFile); err == nil {
		_ = json.Unmarshal(b, &v)
	}
	if v.Commit == "" {
		v.Commit = "unknown"
	}
	return v
})

func (a *API) getVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, loadVersion())
}
