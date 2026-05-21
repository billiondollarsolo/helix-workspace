FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress fonts-dejavu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/helix-drive-preview
COPY server.mjs ./server.mjs

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.mjs"]
