# Copyright (C) 2026 The OpenVoxa Authors
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Caddy with a DNS provider plugin compiled in.
#
# Only needed for Caddyfile.dns. The HTTP and internal paths work with the
# stock caddy:2-alpine image, and docker-compose.yml uses this build only
# when you point CADDYFILE at the DNS variant.
#
# To use a different DNS provider, replace the --with line. The full list
# is at https://caddyserver.com/download - every provider there follows the
# same github.com/caddy-dns/<name> pattern.

FROM caddy:2-builder-alpine AS build

RUN xcaddy build \
    --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine

COPY --from=build /usr/bin/caddy /usr/bin/caddy
