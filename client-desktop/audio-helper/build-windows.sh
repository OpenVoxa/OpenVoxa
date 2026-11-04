#!/bin/sh
# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Cross-builds openvoxa-audio.exe for Windows on Docker (no Rust needed on
# the host). Output: target/x86_64-pc-windows-gnu/release/openvoxa-audio.exe
set -e
cd "$(dirname "$0")"
docker run --rm -v "$PWD":/src -v ovx-cargo:/usr/local/cargo/registry -w /src \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" rust:1-bookworm sh -c '
    set -e
    (dpkg -s gcc-mingw-w64-x86-64 >/dev/null 2>&1) || (apt-get update -qq && apt-get install -y -qq gcc-mingw-w64-x86-64 >/dev/null)
    rustup target add x86_64-pc-windows-gnu >/dev/null 2>&1
    cargo build --release --target x86_64-pc-windows-gnu
    chown -R "$HOST_UID:$HOST_GID" target Cargo.lock'
