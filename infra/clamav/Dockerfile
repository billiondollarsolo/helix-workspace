# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12

# ClamAV 1.5.4 on its upstream Alpine image with patched runtime packages. The
# upstream tag can lag Alpine security releases, so Helix rebuilds, scans, and
# promotes this exact image. Entrypoint, healthcheck, and paths stay upstream;
# the image runs as the upstream clamav account instead of root.
ARG SOURCE_IMAGE=clamav/clamav:1.5.4@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0

FROM ${SOURCE_IMAGE}

LABEL org.opencontainers.image.title="helix-clamav" \
      org.opencontainers.image.description="ClamAV 1.5.4 with patched runtime packages" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/Cisco-Talos/clamav" \
      org.opencontainers.image.version="1.5.4"

RUN apk add --no-cache --upgrade pcre2=10.49-r0 \
    && install -d -o clamav -g clamav -m 0775 /run/clamav \
    && chown -R clamav:clamav /etc/clamav /run/lock /var/lib/clamav /var/log/clamav

# The upstream /init applies CLAMD_CONF_* to /etc/clamav, keeps the signature
# database owned by clamav, and starts freshclam and clamd. Started as the
# clamav account (UID 100, GID 101), each step works without privilege drops.
USER 100:101
