# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12
FROM node:24.18.0-trixie-slim@sha256:ae91dcc111a68c9d2d81ff2a17bda61be126426176fde6fe7d08ab13b7f50573 AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends patch ca-certificates && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:1f139176131be0a7841916a093cd9672f1e08578200fa4f14512a4560b6f22f5 \
    https://codeload.github.com/jitsi/opus-transcriber-proxy/tar.gz/6f7123c20632237fec0ecc95501acf1277041eb3 /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 && npm ci --ignore-scripts
COPY infra/meet/transcriber/per-session-model.patch /tmp/model.patch
RUN patch --batch --fuzz=0 -p1 < /tmp/model.patch \
    && npx vitest run test/unit/utils.test.ts test/unit/OutgoingConnection.test.ts test/unit/backends/OpenAIBackend.test.ts \
    && GIT_HASH=6f7123c-helix-model-routing npm run build:bundle
FROM jitsi/opus-transcriber-proxy:6f7123c20632237fec0ecc95501acf1277041eb3@sha256:4cb583a7b0082407d05a1a07e7c179925423448b4eb05fe618619505851dcb46
COPY --from=build /src/dist/bundle /usr/src/app/dist/bundle
