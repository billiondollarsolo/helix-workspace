# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG BUILD_BASE=golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc

FROM ${BUILD_BASE} AS build

ARG CERBOS_COMMIT=6b40a5f9fa6305a7014a8ea274afefaaa7771679
ARG CERBOS_ARCHIVE_SHA256=4fec19b5347d002b373c484f34298e9b6c2ad3fdc624191de8c808ddd6cac56b
ARG CERBOS_VERSION=0.54.0
ARG CERBOS_BUILD_DATE=2026-07-20T09:27:29Z

ENV GOAMD64=v2

WORKDIR /src

ADD --checksum=sha256:${CERBOS_ARCHIVE_SHA256} \
  https://github.com/cerbos/cerbos/archive/${CERBOS_COMMIT}.tar.gz \
  /tmp/cerbos.tar.gz

RUN tar -xzf /tmp/cerbos.tar.gz --strip-components=1 \
    && rm /tmp/cerbos.tar.gz \
    && go get google.golang.org/grpc@v1.82.1 \
    && go mod verify \
    && CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags="-s -w -buildid= \
        -X github.com/cerbos/cerbos/internal/util.Version=${CERBOS_VERSION} \
        -X github.com/cerbos/cerbos/internal/util.Commit=${CERBOS_COMMIT} \
        -X github.com/cerbos/cerbos/internal/util.BuildDate=${CERBOS_BUILD_DATE}" \
      -o /out/cerbos \
      ./cmd/cerbos

FROM scratch AS runtime

LABEL org.opencontainers.image.title="helix-cerbos" \
      org.opencontainers.image.description="Cerbos 0.54.0 rebuilt with patched grpc-go" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/cerbos/cerbos" \
      org.opencontainers.image.version="0.54.0" \
      org.opencontainers.image.revision="6b40a5f9fa6305a7014a8ea274afefaaa7771679"

ENV CERBOS_CONFIG=__default__

COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/cerbos /cerbos

EXPOSE 3592 3593
VOLUME ["/policies", "/tmp", "/.cache"]

ENTRYPOINT ["/cerbos"]
CMD ["server"]

HEALTHCHECK --interval=10s --timeout=2s --retries=2 CMD ["/cerbos", "healthcheck"]
