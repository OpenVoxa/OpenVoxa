# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Build context is the REPOSITORY ROOT, not server/, because the server
# embeds a bundle built from client-core. See deploy/docker-compose.yml.

# ---------------------------------------------------------------- client
# Bundles client-core into a single script the server can embed. Kept as
# its own stage so a change to Go code does not rebuild the JavaScript,
# and vice versa.
FROM node:22-alpine AS client

WORKDIR /client
COPY client-core/package.json ./
RUN npm install --no-audit --no-fund

COPY client-core/ ./
RUN npm run build

# ---------------------------------------------------------------- server
# Must be at least the version in go.mod's `go` directive. Running
# `go mod tidy` with a newer local toolchain raises that directive, and the
# build then fails here with a confusing "go.mod requires go >= x" error.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Manifests first so dependency downloads cache between builds when only
# source files change.
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ ./

# Must land before `go build`: the embed directive reads the directory at
# compile time, so a bundle copied in afterwards would not be included.
COPY --from=client /client/dist/core.js ./internal/httpapi/debugui/core.js
# LiveKit's browser bundle and its E2EE worker, served from our own origin.
# See client-core/build.mjs for why they are not loaded from a CDN.
COPY --from=client /client/dist/livekit-client.umd.js /client/dist/livekit-client.e2ee.worker.js ./internal/httpapi/debugui/

RUN CGO_ENABLED=0 go build -o /out/openvoxa-server .

# --------------------------------------------------------------- blobdir
# The blob directory has to exist in the image, owned by the user the
# server runs as.
#
# Docker copies the ownership and permissions of the image's directory onto
# a named volume the first time that volume is mounted. Without this stage
# the volume arrives owned by root, and a process running as nonroot cannot
# create anything inside it. Distroless has no shell, so mkdir and chown
# have to happen somewhere that does.
FROM alpine:3 AS blobdir
RUN mkdir -p /var/lib/openvoxa/blobs && chown -R 65532:65532 /var/lib/openvoxa

# ----------------------------------------------------------------- final
# Distroless: no shell, no package manager, minimal attack surface.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/openvoxa-server /openvoxa-server
COPY --from=blobdir --chown=65532:65532 /var/lib/openvoxa /var/lib/openvoxa

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/openvoxa-server"]
