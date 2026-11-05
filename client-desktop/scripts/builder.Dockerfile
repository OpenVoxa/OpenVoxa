# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Throwaway build environment for the Windows installer (scripts/release.mjs).
# electron-builder makes the NSIS uninstaller by running the installer
# stub, which on Linux needs Wine (32-bit too: the stub is x86).
FROM node:22-bookworm
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends wine wine32 wine64 \
 && rm -rf /var/lib/apt/lists/*
ENV WINEDEBUG=-all
