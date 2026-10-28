// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package config loads server configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	ListenAddr  string
	DatabaseURL string

	// DebugUI serves a bare-bones test client at /debug/. Off by default
	// and should stay off anywhere real.
	DebugUI bool
}

// Load reads configuration from the environment. Required values with no
// sensible default cause an error rather than a silent fallback, so a
// misconfigured server fails at startup instead of at the first request.
func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:  env("OPENVOXA_LISTEN_ADDR", ":8080"),
		DatabaseURL: os.Getenv("OPENVOXA_DATABASE_URL"),
		DebugUI:     envBool("OPENVOXA_DEBUG_UI", false),
	}

	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("OPENVOXA_DATABASE_URL is required")
	}

	return cfg, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envBool treats an unparseable value as the fallback rather than an error.
// A typo in a debug flag should not stop the server booting.
func envBool(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}
