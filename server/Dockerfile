# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Build context is the REPOSITORY ROOT, not server/, because the server
# embeds the web client, which is built from client-web and client-core.
# See deploy/docker-compose.yml.

# ---------------------------------------------------------------- client
# Installs client-core and applies its ts-mls patch (npm run build), for
# client-web to import as source. Kept as its own stage so a change to Go
# code does not rebuild the JavaScript, and vice versa.
FROM node:22-alpine AS client

WORKDIR /client
COPY client-core/package.json ./
RUN npm install --no-audit --no-fund

COPY client-core/ ./
RUN npm run build

# ------------------------------------------------------------------- web
# Builds client-web (React, Vite) into static files the server embeds and
# serves at /. npm ci installs exactly what package-lock.json records.
# client-web imports client-core as source ("@core/..." -> ../client-core/src),
# so the client stage's tree, node_modules included, sits beside it.
FROM node:22-alpine AS web

WORKDIR /app/client-web
COPY --from=client /client /app/client-core
COPY client-web/package.json client-web/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client-web/ ./
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

# The web client replaces the placeholder in webui/. Must land before
# `go build`: the embed directive reads the directory at compile time, so
# files copied in afterwards would not be included.
COPY --from=web /app/client-web/dist/ ./internal/httpapi/webui/

RUN CGO_ENABLED=0 go build -o /out/openvoxa-server .

# --------------------------------------------------------------- blobdir
# The blob and key directories have to exist in the image, owned by the
# user the server runs as.
#
# Docker copies the ownership and permissions of the image's directory onto
# a named volume the first time that volume is mounted. Without this stage
# the volume arrives owned by root, and a process running as nonroot cannot
# create anything inside it. Distroless has no shell, so mkdir and chown
# have to happen somewhere that does.
FROM alpine:3 AS blobdir
RUN mkdir -p /var/lib/openvoxa/blobs /var/lib/openvoxa/keys \
 && chmod 700 /var/lib/openvoxa/keys \
 && chown -R 65532:65532 /var/lib/openvoxa

# ----------------------------------------------------------------- final
# Distroless: no shell, no package manager, minimal attack surface.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/openvoxa-server /openvoxa-server
COPY --from=blobdir --chown=65532:65532 /var/lib/openvoxa /var/lib/openvoxa

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/openvoxa-server"]
