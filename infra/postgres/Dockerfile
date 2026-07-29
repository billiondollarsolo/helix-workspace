# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

ARG POSTGRES_BASE=postgres:18.4-alpine3.24@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15
ARG GOSU_BUILD_BASE=golang:1.26.5-alpine3.24@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2

FROM ${POSTGRES_BASE} AS build

ARG PGVECTOR_COMMIT=159b79aaad5983fb7459c1e3df2897fbb2d11788
ARG PGVECTOR_ARCHIVE_SHA256=9a483fad70ae2e0a50b3dccb6c4b4931d9a07375a1d5815e82b57870448a7d52

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

RUN apk add --no-cache c-ares=1.34.8-r0

LABEL org.opencontainers.image.title="helix-postgres-pgvector" \
      org.opencontainers.image.description="PostgreSQL 18 with pgvector 0.8.5 and a patched gosu runtime" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/pgvector/pgvector" \
      org.opencontainers.image.revision="159b79aaad5983fb7459c1e3df2897fbb2d11788" \
      org.opencontainers.image.version="0.8.5" \
      io.helix.gosu.revision="6456aaa0f3c854d199d0f037f068eb97515b7513"

COPY --from=build /out/ /
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu
