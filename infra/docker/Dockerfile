# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

ARG BUILD_BASE=node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573
ARG RUNTIME_BASE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
ARG GO_BUILD_BASE=golang:1.26.10-alpine3.24@sha256:9ce231b28998b32e116927c61aa5c406183061d4f3f2d61b292c88e7f6bdf7ca
ARG WEB_RUNTIME_BASE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# Build the stock Caddy command with patched transitive modules and a patched Go
# toolchain. The upstream binary image can lag fixed Go/library releases even
# when its tag is current, so the vulnerability gate scans this exact binary.
FROM ${GO_BUILD_BASE} AS caddy-build

WORKDIR /src

RUN go mod init helix.invalid/caddy-build \
    && go get github.com/caddyserver/caddy/v2/cmd/caddy@v2.11.4 \
    && go get google.golang.org/grpc@v1.83.2 golang.org/x/net@v0.60.0

RUN mkdir -p /out \
    && CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags="-s -w -buildid= -X github.com/caddyserver/caddy/v2.CustomVersion=v2.11.4-helix" \
      -o /out/caddy \
      github.com/caddyserver/caddy/v2/cmd/caddy

# shortcut: distrust both incident anchors until Node releases its intermediate-key blocklist.
FROM ${BUILD_BASE} AS trusted-base
RUN sed -i \
      -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt$|!mozilla/emSign_ECC_Root_CA_-_G3.crt|' \
      -e 's|^mozilla/Comodo_AAA_Services_root.crt$|!mozilla/Comodo_AAA_Services_root.crt|' \
      /etc/ca-certificates.conf \
    && update-ca-certificates --fresh \
    && mkdir -p /etc/ssl/helix-empty
ENV NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/helix-empty

FROM trusted-base AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate


COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.mjs turbo.json ./
COPY patches/ patches/
COPY apps/helix/package.json apps/helix/
COPY packages/ packages/

RUN --mount=type=cache,id=helix-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @helix/app...

COPY apps/helix/ apps/helix/
COPY infra/scripts/prune-production-deploy.mjs infra/scripts/prune-production-deploy.mjs

RUN pnpm --filter @helix/app... run build \
    && mkdir -p apps/helix/dist/db/migrations \
    && cp apps/helix/src/db/migrations/*.sql apps/helix/dist/db/migrations/ \
    && pnpm --filter @helix/app deploy --prod /app/deploy \
    && node infra/scripts/prune-production-deploy.mjs /app/deploy

FROM ${RUNTIME_BASE} AS runtime

LABEL org.opencontainers.image.title="helix-workspace" \
      org.opencontainers.image.description="Helix Workspace API and worker runtime" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/billiondollarsolo/helix-workspace"

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --use-openssl-ca" \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/helix-empty \
    PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /app

COPY --from=trusted-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=trusted-base /etc/ssl/helix-empty /etc/ssl/helix-empty
COPY --from=build --chown=10001:10001 /app/deploy /app

USER 10001:10001

EXPOSE 3000 2525

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]

# Optional operator-side recovery executor. Commands and tools are operator-owned;
# the API runtime never receives Docker sockets or cluster-admin permissions.
FROM trusted-base AS backup-worker
WORKDIR /app
COPY --from=build --chown=10001:10001 /app/deploy /app
RUN mkdir -p /var/lib/helix-backup-worker \
    && chown 10001:10001 /var/lib/helix-backup-worker \
    && chmod 0700 /var/lib/helix-backup-worker \
    && command -v flock
USER 10001:10001
EXPOSE 3081
ENTRYPOINT ["node"]
CMD ["dist/platform/backup/federation-worker.js", "serve", "/etc/helix-backup-worker/worker.json"]

FROM trusted-base AS web-build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.18.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.mjs turbo.json ./
COPY patches/ patches/
COPY apps/web/package.json apps/web/
COPY packages/ packages/

RUN --mount=type=cache,id=helix-web-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @helix/web...

COPY apps/web/ apps/web/

RUN pnpm --filter @helix/web... run build

FROM ${WEB_RUNTIME_BASE} AS web-runtime

LABEL org.opencontainers.image.title="helix-workspace-web" \
      org.opencontainers.image.description="Helix Workspace web client and production edge" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/billiondollarsolo/helix-workspace"

RUN apk add --no-cache \
      libcrypto3=3.5.9-r0 \
      libssl3=3.5.9-r0 \
    && addgroup -g 10001 -S helix \
    && adduser -u 10001 -S -D -G helix helix \
    && mkdir -p /config /data /srv /run/helix-edge-certs /run/caddy-admin \
    && chown -R 10001:10001 /config /data /srv /run/helix-edge-certs /run/caddy-admin

# Caddy keeps certificates and its autosaved config under these. Without them it
# falls back to the home directory, which is read-only in production.
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/helix-empty \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/config

COPY --from=trusted-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=trusted-base /etc/ssl/helix-empty /etc/ssl/helix-empty
COPY --from=caddy-build /out/caddy /usr/bin/caddy
COPY --chown=10001:10001 infra/caddy/Caddyfile.production /etc/caddy/Caddyfile
COPY --chown=10001:10001 infra/caddy/optional/ /etc/caddy/optional/
COPY --from=web-build --chown=10001:10001 /app/apps/web/dist/ /srv/

USER 10001:10001

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["wget", "--spider", "-q", "http://127.0.0.1:8081/healthz"]

ENTRYPOINT ["caddy"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
