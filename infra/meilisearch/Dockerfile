# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

ARG BUILD_BASE=rust:1.95-alpine@sha256:606fd313a0f49743ee2a7bd49a0914bab7deedb12791f3a846a34a4711db7ed2
ARG RUNTIME_BASE=alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

FROM ${BUILD_BASE} AS source
RUN apk add --no-cache build-base openssl-dev ca-certificates
WORKDIR /src
ENV RUSTUP_TOOLCHAIN=1.95.0 RUSTFLAGS="-C target-feature=-crt-static" CARGO_BUILD_JOBS=6 CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
ADD --checksum=sha256:255a0113f87bf434ccfd7faa9990f3a282fdd8d272ba17e62ee286953ed0d897 https://github.com/meilisearch/meilisearch/archive/refs/tags/v1.51.0.tar.gz /tmp/source.tar.gz
RUN tar -xzf /tmp/source.tar.gz --strip-components=1 \
    && cargo update -p rustls-webpki --precise 0.103.16 \
    && cargo update -p webpki-roots --precise 1.0.10 \
    && cargo build --release --locked -p meilisearch

FROM ${RUNTIME_BASE} AS runtime

RUN apk add --no-cache ca-certificates
# shortcut: distrust incident anchors until all runtime libraries reject the compromised keys.
RUN sed -i \
      -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt$|!mozilla/emSign_ECC_Root_CA_-_G3.crt|' \
      -e 's|^mozilla/Comodo_AAA_Services_root.crt$|!mozilla/Comodo_AAA_Services_root.crt|' \
      /etc/ca-certificates.conf \
    && update-ca-certificates --fresh \
    && mkdir -p /etc/ssl/helix-empty
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/helix-empty

RUN apk add --no-cache \
      libcrypto3=3.5.9-r0 \
      libssl3=3.5.9-r0 \
    && addgroup -S -g 10001 meilisearch \
    && adduser -S -D -H -u 10001 -G meilisearch -h /meili_data -s /sbin/nologin meilisearch \
    && install -d -o meilisearch -g meilisearch -m 0750 /meili_data

LABEL org.opencontainers.image.title="helix-meilisearch" \
      org.opencontainers.image.description="Meilisearch 1.51.0 on a patched minimal runtime" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/meilisearch/meilisearch" \
      org.opencontainers.image.version="1.51.0"

ENV MEILI_HTTP_ADDR=0.0.0.0:7700 \
    MEILI_SERVER_PROVIDER=docker

COPY --from=source /src/target/release/meilisearch /bin/meilisearch
COPY --from=source /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1

# Like the upstream image, keep the database (data.ms), dumps, and snapshots
# under /meili_data, where Compose mounts the meili-data volume.
WORKDIR /meili_data
USER 10001:10001

EXPOSE 7700

ENTRYPOINT ["/bin/meilisearch"]
