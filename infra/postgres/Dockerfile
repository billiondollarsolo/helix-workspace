FROM postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73

ARG PGVECTOR_COMMIT=778dacf20c07caf904557a88705142631818d8cb
ARG PGVECTOR_SHA256=4c33cf053329784ba6d992d05c9588b93789e907a7511f20ff5a5a5b8a0703c1

RUN apk add --no-cache --virtual .pgvector-build-deps \
      build-base \
      ca-certificates \
      clang21 \
      llvm21 \
    && wget -qO /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/${PGVECTOR_COMMIT}.tar.gz" \
    && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
    && mkdir /tmp/pgvector \
    && tar -xzf /tmp/pgvector.tar.gz --strip-components=1 -C /tmp/pgvector \
    && make -C /tmp/pgvector \
    && make -C /tmp/pgvector install \
    && rm -rf /tmp/pgvector /tmp/pgvector.tar.gz \
    && apk del .pgvector-build-deps
