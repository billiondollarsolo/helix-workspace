# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG SOURCE_IMAGE=getmeili/meilisearch:v1.45.1@sha256:ac40212f9e5a7526d8007586e3e46fb0441d29dd36c7b02fa2341d2c9a1f6493
ARG RUNTIME_BASE=alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

FROM ${SOURCE_IMAGE} AS source

FROM ${RUNTIME_BASE} AS runtime

LABEL org.opencontainers.image.title="helix-meilisearch" \
      org.opencontainers.image.description="Meilisearch 1.45.1 on a patched minimal runtime" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/meilisearch/meilisearch" \
      org.opencontainers.image.version="1.45.1"

ENV MEILI_HTTP_ADDR=0.0.0.0:7700 \
    MEILI_SERVER_PROVIDER=docker

COPY --from=source /bin/meilisearch /bin/meilisearch
COPY --from=source /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1

EXPOSE 7700

ENTRYPOINT ["/bin/meilisearch"]
