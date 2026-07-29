# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

ARG SOURCE_IMAGE=getmeili/meilisearch:v1.51.0@sha256:a9eb29ee09ab4943db3b4c68620bd6f3382e6b2b0ac4431c0e607b48dbcd4c14
ARG RUNTIME_BASE=alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

FROM ${SOURCE_IMAGE} AS source

FROM ${RUNTIME_BASE} AS runtime

RUN apk add --no-cache \
      libcrypto3=3.5.7-r0 \
      libssl3=3.5.7-r0

LABEL org.opencontainers.image.title="helix-meilisearch" \
      org.opencontainers.image.description="Meilisearch 1.51.0 on a patched minimal runtime" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/meilisearch/meilisearch" \
      org.opencontainers.image.version="1.51.0"

ENV MEILI_HTTP_ADDR=0.0.0.0:7700 \
    MEILI_SERVER_PROVIDER=docker

COPY --from=source /bin/meilisearch /bin/meilisearch
COPY --from=source /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1

EXPOSE 7700

ENTRYPOINT ["/bin/meilisearch"]
