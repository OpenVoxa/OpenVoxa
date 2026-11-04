// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package config loads server configuration from the environment.
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	ListenAddr  string
	DatabaseURL string

	// TrustProxy makes the server read the client address from the
	// X-Forwarded-For header instead of the TCP connection.
	//
	// Only enable this when a reverse proxy you control sits in front of
	// the server. With it on and no such proxy, anyone can set that header
	// themselves and walk straight past the rate limiter.
	TrustProxy bool

	// BlobDir is where attachment bytes live. Should be a mounted volume;
	// losing it means losing every uploaded file.
	BlobDir string

	// KeyDir holds one key per account for crypto-shredding. Must NOT be
	// inside the database's backups; see docs/decisions.md, Encryption,
	// "Account deletion is crypto-shredding". Losing it makes plaintext
	// channel history unreadable.
	KeyDir string

	// KEK, when set, is a 32-byte key-encryption key that wraps every
	// per-account key where it rests on disk (envelope encryption). A
	// stolen key folder, or a backup of it, is then useless without this
	// key. It must live OUTSIDE the key folder and off the database
	// backups, so that neither backup alone can decrypt anything. Nil
	// leaves the per-account keys stored in the clear (the default, for
	// compatibility). See docs/decisions.md, Encryption, and
	// deploy/README.md, "Account keys and backups".
	KEK []byte

	// MaxAttachmentBytes caps a single upload. Operators pay for the disk
	// and the bandwidth, so they set the ceiling.
	MaxAttachmentBytes int64

	// GIF search. Empty provider disables the feature entirely, which is
	// the default: neither provider is privacy-clean, so an operator has
	// to opt in knowingly.
	GIFProvider string
	GIFAPIKey   string

	// LiveKit holds the media server settings. Voice is disabled when the
	// key or secret is empty, so a text-only deployment needs no LiveKit.
	LiveKit LiveKitConfig
}

type LiveKitConfig struct {
	// URL is what CLIENTS connect to, so it must be reachable from their
	// machines. Not the internal Docker hostname.
	URL       string
	APIKey    string
	APISecret string

	// APIURL is where THIS SERVER reaches LiveKit's HTTP API, to remove a
	// participant who lost access. Under docker compose that is the host
	// (http://host.docker.internal:7880, LiveKit being on the host network);
	// left empty it is derived from URL.
	APIURL string
}

// Load reads configuration from the environment. Required values with no
// sensible default cause an error rather than a silent fallback, so a
// misconfigured server fails at startup instead of at the first request.
func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:  env("OPENVOXA_LISTEN_ADDR", ":8080"),
		DatabaseURL: os.Getenv("OPENVOXA_DATABASE_URL"),
		BlobDir:     env("OPENVOXA_BLOB_DIR", "/var/lib/openvoxa/blobs"),
		KeyDir:      env("OPENVOXA_KEY_DIR", "/var/lib/openvoxa/keys"),

		MaxAttachmentBytes: int64(envInt("OPENVOXA_MAX_ATTACHMENT_MB", 25)) * 1024 * 1024,

		GIFProvider: os.Getenv("OPENVOXA_GIF_PROVIDER"),
		GIFAPIKey:   os.Getenv("OPENVOXA_GIF_API_KEY"),
		TrustProxy:  envBool("OPENVOXA_TRUST_PROXY", false),

		LiveKit: LiveKitConfig{
			URL:       os.Getenv("OPENVOXA_LIVEKIT_URL"),
			APIKey:    os.Getenv("OPENVOXA_LIVEKIT_API_KEY"),
			APISecret: os.Getenv("OPENVOXA_LIVEKIT_API_SECRET"),
			APIURL:    os.Getenv("OPENVOXA_LIVEKIT_API_URL"),
		},
	}

	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("OPENVOXA_DATABASE_URL is required")
	}

	switch cfg.GIFProvider {
	case "", "giphy", "tenor":
	default:
		return nil, fmt.Errorf("OPENVOXA_GIF_PROVIDER must be giphy, tenor, or empty")
	}
	if cfg.GIFProvider != "" && cfg.GIFAPIKey == "" {
		return nil, fmt.Errorf("OPENVOXA_GIF_API_KEY is required when a GIF provider is set")
	}

	// Partial LiveKit configuration is a mistake worth failing on. Silently
	// disabling voice because one variable was typo'd would be worse than
	// refusing to start.
	lkSet := 0
	for _, v := range []string{cfg.LiveKit.URL, cfg.LiveKit.APIKey, cfg.LiveKit.APISecret} {
		if v != "" {
			lkSet++
		}
	}
	if lkSet != 0 && lkSet != 3 {
		return nil, fmt.Errorf(
			"OPENVOXA_LIVEKIT_URL, _API_KEY and _API_SECRET must all be set or all be empty")
	}

	kek, err := loadKEK()
	if err != nil {
		return nil, err
	}
	cfg.KEK = kek

	return cfg, nil
}

// loadKEK reads the key-encryption key from OPENVOXA_KEK (base64) or from
// the file named by OPENVOXA_KEK_FILE (base64, whitespace trimmed). A file
// suits Docker/systemd secrets, which mount a secret as a file rather than
// an environment variable. Returns nil when neither is set.
func loadKEK() ([]byte, error) {
	inline := os.Getenv("OPENVOXA_KEK")
	file := os.Getenv("OPENVOXA_KEK_FILE")
	switch {
	case inline == "" && file == "":
		return nil, nil
	case inline != "" && file != "":
		return nil, errors.New("set only one of OPENVOXA_KEK or OPENVOXA_KEK_FILE")
	}

	encoded := inline
	if file != "" {
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("reading OPENVOXA_KEK_FILE: %w", err)
		}
		encoded = string(data)
	}

	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return nil, fmt.Errorf("the key-encryption key must be base64: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("the key-encryption key must decode to 32 bytes, got %d", len(raw))
	}
	return raw, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envBool treats an unparseable value as the fallback rather than an error.
// A typo in a debug flag should not stop the server booting.
// envInt treats an unparseable or non-positive value as the fallback. A
// typo should not silently disable uploads or allow unbounded ones.
func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

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
