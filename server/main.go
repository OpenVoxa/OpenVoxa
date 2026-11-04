// Copyright (C) 2026 The OpenVoxa Authors
// SPDX-License-Identifier: AGPL-3.0-or-later

package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/openvoxa/openvoxa/server/internal/blob"
	"github.com/openvoxa/openvoxa/server/internal/config"
	"github.com/openvoxa/openvoxa/server/internal/db"
	"github.com/openvoxa/openvoxa/server/internal/httpapi"
	"github.com/openvoxa/openvoxa/server/internal/keystore"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Host-side commands (cli.go), e.g. grant-admin.
	if ok, err := runCommand(os.Args[1:]); ok {
		if err != nil {
			exitWith(err)
		}
		return
	}

	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	// Signal context: Ctrl-C or SIGTERM cancels it, which unwinds everything below.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	slog.Info("database connected")

	if err := db.Migrate(ctx, pool); err != nil {
		return err
	}

	blobs, err := blob.NewStore(cfg.BlobDir)
	if err != nil {
		return err
	}
	slog.Info("blob store ready", "dir", cfg.BlobDir,
		"max_attachment_mb", cfg.MaxAttachmentBytes/(1024*1024))

	keys, err := keystore.Open(cfg.KeyDir, cfg.KEK)
	if err != nil {
		return err
	}
	slog.Info("key store ready", "dir", cfg.KeyDir, "at_rest_encryption", keys.WrapsAtRest())
	if !keys.WrapsAtRest() {
		slog.Info("account keys are stored in the clear; set OPENVOXA_KEK to encrypt them at rest (see deploy/README.md)")
	}

	// Upgrade any clear-text key files to wrapped, when a KEK is set.
	// Readers accept both, so this runs alongside normal traffic.
	go keys.WrapExisting(ctx)

	api := httpapi.New(pool, cfg, blobs, keys)
	api.LogSetupCodeIfEmpty(ctx)

	// Seal plaintext written before crypto-shredding existed. Readers
	// handle both forms, so this runs alongside normal traffic.
	go api.SealExisting(ctx)

	db.StartSessionSweep(ctx, pool)

	// The sweep reports what it removed so connected clients can drop the
	// same messages locally instead of displaying rows that no longer
	// exist.
	// A retention change wakes it, so a shorter policy applies at once.
	api.SetRetentionWake(db.StartRetentionSweep(ctx, pool, api.NotifyChannelPurged))
	db.StartBlobGC(ctx, pool, blobs)

	// Revoking an idle device needs members to remove it from their
	// groups, which the access_changed event asks them to do.
	db.StartDeviceExpirySweep(ctx, pool, api.NotifyAccessChanged)

	// Stops screen shares above the server's quality limit, if one is set.
	api.StartShareLimitWatch(ctx)

	// Lifts timed server mutes and gives the microphone back mid-call.
	api.StartVoiceMuteSweep(ctx)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           api,
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Serve in the background so the main goroutine can wait on the signal.
	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		slog.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}
