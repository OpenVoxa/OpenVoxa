# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later

# Must be at least the version in go.mod's `go` directive. Running
# `go mod tidy` with a newer local toolchain raises that directive, and the
# build then fails here with a confusing "go.mod requires go >= x" error.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Copy manifests first so dependency downloads are cached between builds
# when only source files change.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 go build -o /out/openvoxa-server .

# Distroless: no shell, no package manager, minimal attack surface.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/openvoxa-server /openvoxa-server

EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/openvoxa-server"]
