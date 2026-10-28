// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package config loads server configuration from the environment.
package config

import (
	"fmt"
	"os"
)

type Config struct {
	ListenAddr  string
	DatabaseURL string
}

// Load reads configuration from the environment. Required values with no
// sensible default cause an error rather than a silent fallback, so a
// misconfigured server fails at startup instead of at the first request.
func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:  env("OPENVOXA_LISTEN_ADDR", ":8080"),
		DatabaseURL: os.Getenv("OPENVOXA_DATABASE_URL"),
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
