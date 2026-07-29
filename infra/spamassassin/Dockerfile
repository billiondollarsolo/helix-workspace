# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG SOURCE_IMAGE=axllent/spamassassin:latest@sha256:10129cf33e9a18f4d623b487cf33e1470ffeef9d6942ad6b04efebedc84d27b4
ARG RULES_URL=https://downloads.apache.org/spamassassin/source/Mail-SpamAssassin-rules-4.0.2.r1928015.tgz
ARG RULES_SHA256=f82128687117113dbe40bdc4e3141b87f96c2b01519c9022597da47e726a613e
ARG RULES_ASC_URL=https://downloads.apache.org/spamassassin/source/Mail-SpamAssassin-rules-4.0.2.r1928015.tgz.asc
ARG RULES_ASC_SHA256=0465aff61b900fc20b99a8b83db8e8801efe2204814c6f6897c94539b6fe67a5

FROM ${SOURCE_IMAGE}

ARG RULES_URL
ARG RULES_SHA256
ARG RULES_ASC_URL
ARG RULES_ASC_SHA256

LABEL org.opencontainers.image.title="helix-spamassassin" \
      org.opencontainers.image.description="SpamAssassin 4.0.2 with patched runtime packages" \
      org.opencontainers.image.vendor="Helix" \
      org.opencontainers.image.source="https://github.com/axllent/spamassassin" \
      org.opencontainers.image.version="4.0.2"

RUN apk update \
    && apk add --no-cache --upgrade c-ares=1.34.8-r0 \
    && rm -rf /var/cache/apk/*

RUN rules_archive=/tmp/Mail-SpamAssassin-rules-4.0.2.r1928015.tgz \
    && wget -q -O "${rules_archive}" "${RULES_URL}" \
    && wget -q -O "${rules_archive}.asc" "${RULES_ASC_URL}" \
    && echo "${RULES_SHA256}  ${rules_archive}" | sha256sum -c - \
    && echo "${RULES_ASC_SHA256}  ${rules_archive}.asc" | sha256sum -c - \
    && install -d /opt/helix-spamassassin-rules/4.000002 \
    && sa-update \
      --updatedir /opt/helix-spamassassin-rules/4.000002 \
      --install "${rules_archive}" \
    && install -d /var/lib/spamassassin/4.000002 \
    && cp -a /opt/helix-spamassassin-rules/4.000002/. /var/lib/spamassassin/4.000002/ \
    && tar -xzf "${rules_archive}" -C /usr/share/spamassassin \
    && rm "${rules_archive}" "${rules_archive}.asc" \
    && test -s /var/lib/spamassassin/4.000002/updates_spamassassin_org/10_default_prefs.cf \
    && test -s /var/lib/spamassassin/4.000002/updates_spamassassin_org/72_active.cf

COPY --chmod=0755 entrypoint.sh /usr/local/bin/helix-spamassassin-entrypoint

ENTRYPOINT ["/usr/local/bin/helix-spamassassin-entrypoint"]
CMD ["/init.sh"]
