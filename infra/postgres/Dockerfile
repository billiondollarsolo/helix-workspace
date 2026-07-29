# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG POSTGRES_BASE=postgres:17.10-alpine3.24@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
ARG GOSU_BUILD_BASE=golang:1.26.5-alpine3.23@sha256:622e56dbc11a8cfe87cafa2331e9a201877271cbff918af53d3be315f3da88cc

FROM ${POSTGRES_BASE} AS build

ARG PGVECTOR_COMMIT=778dacf20c07caf904557a88705142631818d8cb
ARG PGVECTOR_ARCHIVE_SHA256=4c33cf053329784ba6d992d05c9588b93789e907a7511f20ff5a5a5b8a0703c1

WORKDIR /src

RUN apk add --no-cache \
      build-base=0.5-r4 \
      clang21=21.1.8-r3 \
      llvm21=21.1.8-r1

ADD --checksum=sha256:${PGVECTOR_ARCHIVE_SHA256} \
  https://github.com/pgvector/pgvector/archive/${PGVECTOR_COMMIT}.tar.gz \
  /tmp/pgvector.tar.gz

RUN tar -xzf /tmp/pgvector.tar.gz --strip-components=1 \
    && make OPTFLAGS="" \
    && make OPTFLAGS="" install DESTDIR=/out

FROM ${GOSU_BUILD_BASE} AS gosu-build

ARG GOSU_COMMIT=6456aaa0f3c854d199d0f037f068eb97515b7513
ARG GOSU_ARCHIVE_SHA256=33d7537d588ea49458b9509bcf4554bdf5ceacc66da71e5caa1058ea3b689c3b

WORKDIR /src

ADD --checksum=sha256:${GOSU_ARCHIVE_SHA256} \
  https://github.com/tianon/gosu/archive/${GOSU_COMMIT}.tar.gz \
  /tmp/gosu.tar.gz

RUN tar -xzf /tmp/gosu.tar.gz --strip-components=1 \
    && go get golang.org/x/sys@v0.45.0 \
    && go mod verify \
    && CGO_ENABLED=0 go build \
      -buildvcs=false \
      -trimpath \
      -ldflags="-s -w -buildid=" \
      -o /out/gosu \
      .

FROM ${POSTGRES_BASE} AS runtime

LABEL org.opencontainers.image.title="helix-postgres-pgvector" \
      org.opencontainers.image.description="PostgreSQL 17 with pgvector 0.8.1 and a patched gosu runtime" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/pgvector/pgvector" \
      org.opencontainers.image.revision="778dacf20c07caf904557a88705142631818d8cb" \
      org.opencontainers.image.version="0.8.1" \
      io.helix.gosu.revision="6456aaa0f3c854d199d0f037f068eb97515b7513"

COPY --from=build /out/ /
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu
