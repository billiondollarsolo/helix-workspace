FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu poppler-utils tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/helix-drive-preview
COPY server.mjs ./server.mjs

ENV HOME=/tmp/helix-home \
    PORT=8080
EXPOSE 8080

USER 65532:65532
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.mjs"]
