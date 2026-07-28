# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG BUILD_BASE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG RUNTIME_BASE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG CADDY_BASE=caddy:2.10.0-alpine@sha256:ae4458638da8e1a91aafffb231c5f8778e964bca650c8a8cb23a7e8ac557aa3c

FROM ${BUILD_BASE} AS editors-build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Build the existing paired package boundary from its reviewed checkout.
# Production keeps the Editors module disabled; these artifacts only satisfy
# current file-linked package dependencies and do not enable native editing.
COPY --from=helix_editors / /helix-editors/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json /helix-workspace/
COPY packages/config/ /helix-workspace/packages/config/
COPY packages/contracts/ /helix-workspace/packages/contracts/
COPY packages/sdk-types/ /helix-workspace/packages/sdk-types/

WORKDIR /helix-workspace
RUN --mount=type=cache,id=helix-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @helix/sdk-types... \
    && pnpm --filter @helix/sdk-types... run build

WORKDIR /helix-editors
RUN --mount=type=cache,id=helix-editors-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile \
    && pnpm \
      --filter @helix/editors-core-app... \
      --filter @helix/editors-format-loader \
      --filter @helix/editors-ui \
      run build

FROM ${BUILD_BASE} AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY --from=editors-build /helix-editors/packages/ /helix-editors/packages/

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/helix/package.json apps/helix/
COPY packages/ packages/

RUN --mount=type=cache,id=helix-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @helix/app...

COPY apps/helix/ apps/helix/

RUN pnpm --filter @helix/app... run build \
    && mkdir -p apps/helix/dist/db/migrations \
    && cp apps/helix/src/db/migrations/*.sql apps/helix/dist/db/migrations/ \
    && pnpm --filter @helix/app deploy --prod /app/deploy

FROM ${RUNTIME_BASE} AS runtime

LABEL org.opencontainers.image.title="helix-workspace" \
      org.opencontainers.image.description="Helix Workspace API and worker runtime" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/billiondollarsolo/helix-workspace"

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

RUN groupadd --system --gid 10001 helix \
    && useradd --system --uid 10001 --gid 10001 \
        --home-dir /app --shell /usr/sbin/nologin helix

COPY --from=build --chown=10001:10001 /app/deploy /app

USER 10001:10001

EXPOSE 3000 2525

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "dist/index.js"]

FROM ${BUILD_BASE} AS web-build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    VITE_HELIX_MVP_ONLY=true

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY --from=editors-build /helix-editors/packages/ /helix-editors/packages/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/
COPY packages/ packages/

RUN --mount=type=cache,id=helix-web-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @helix/web...

COPY apps/web/ apps/web/

RUN pnpm --filter @helix/web... run build

FROM ${CADDY_BASE} AS web-runtime

LABEL org.opencontainers.image.title="helix-workspace-web" \
      org.opencontainers.image.description="Helix Workspace web client and production edge" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/billiondollarsolo/helix-workspace"

RUN addgroup -g 10001 -S helix \
    && adduser -u 10001 -S -D -G helix helix \
    && chown -R 10001:10001 /config /data /srv

COPY --chown=10001:10001 infra/caddy/Caddyfile.production /etc/caddy/Caddyfile
COPY --from=web-build --chown=10001:10001 /app/apps/web/dist/ /srv/

USER 10001:10001

EXPOSE 80 443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["wget", "--spider", "-q", "http://127.0.0.1/healthz"]
