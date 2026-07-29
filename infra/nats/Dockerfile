# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG BUILD_BASE=golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc
ARG RUNTIME_BASE=alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

FROM ${BUILD_BASE} AS build

ARG NATS_SERVER_COMMIT=0cbd01caf8f29011c26273ff7662addd3830396a
ARG NATS_SERVER_ARCHIVE_SHA256=bb0b967681b7f08388ba8f1dfddda68718cc47228ffb8503597e6b89da9a4658

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
      org.opencontainers.image.description="NATS 2.14.0 rebuilt with patched Go and x/crypto" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/nats-io/nats-server" \
      org.opencontainers.image.revision="0cbd01caf8f29011c26273ff7662addd3830396a"

COPY --from=build /out/nats-server /usr/local/bin/nats-server

EXPOSE 4222 6222 8222

ENTRYPOINT ["/usr/local/bin/nats-server"]
