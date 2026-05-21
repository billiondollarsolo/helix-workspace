FROM postgres:17-alpine

ARG PGVECTOR_VERSION=0.8.1

RUN apk add --no-cache --virtual .pgvector-build-deps \
      build-base \
      ca-certificates \
      clang19 \
      git \
      llvm19 \
    && git clone --branch "v${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
    && make -C /tmp/pgvector \
    && make -C /tmp/pgvector install \
    && rm -rf /tmp/pgvector \
    && apk del .pgvector-build-deps
