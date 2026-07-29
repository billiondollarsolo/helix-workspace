# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

ARG BUILD_BASE=golang:1.26.5-alpine3.24@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2
ARG RUNTIME_BASE=alpine:3.24.0@sha256:a2d49ea686c2adfe3c992e47dc3b5e7fa6e6b5055609400dc2acaeb241c829f4

FROM ${BUILD_BASE} AS build

ARG NATS_SERVER_COMMIT=9b17a586be69c9ff36e4c84a421ca47da410b561
ARG NATS_SERVER_ARCHIVE_SHA256=9fe94d2ca52ff48dc6d8d5f16f8eb6da2cf1f0cc61fd2cc9df868a5a813f3671

WORKDIR /src

ADD --checksum=sha256:${NATS_SERVER_ARCHIVE_SHA256} \
  https://github.com/nats-io/nats-server/archive/${NATS_SERVER_COMMIT}.tar.gz \
  /tmp/nats-server.tar.gz

RUN tar -xzf /tmp/nats-server.tar.gz --strip-components=1 \
    && rm /tmp/nats-server.tar.gz \
    && go get golang.org/x/crypto@v0.52.0 \
    && go mod verify \
    && CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags="-s -w -buildid=" \
      -o /out/nats-server \
      .

FROM ${RUNTIME_BASE} AS runtime

LABEL org.opencontainers.image.title="helix-nats-server" \
      org.opencontainers.image.description="NATS 2.14.3 rebuilt with patched Go and x/crypto" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/nats-io/nats-server" \
      org.opencontainers.image.revision="9b17a586be69c9ff36e4c84a421ca47da410b561"

COPY --from=build /out/nats-server /usr/local/bin/nats-server

EXPOSE 4222 6222 8222

ENTRYPOINT ["/usr/local/bin/nats-server"]
