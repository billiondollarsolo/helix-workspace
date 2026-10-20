# syntax=docker/dockerfile:1.25.0@sha256:0adf442eae370b6087e08edc7c50b552d80ddf261576f4ebd6421006b2461f12
# Development remediation for pinned upstream Meet and inbound-mail images.
# Scan the resulting image and record its digest before deploying it.
ARG SOURCE_IMAGE=jitsi/prosody:stable-11031@sha256:926c508c0d9198bf9d0b6adb88ce9092461e9a79e2895fb57fe4ef5f44ff3523
ARG BUILD_BASE=golang:1.26.10-alpine3.24@sha256:9ce231b28998b32e116927c61aa5c406183061d4f3f2d61b292c88e7f6bdf7ca

FROM ${BUILD_BASE} AS tpl-build
WORKDIR /src
ADD --checksum=sha256:c4b6bb4497a3161522eb434fda439ef59d9a0e2e387b829f4a5a81cae489aec8 \
    https://github.com/jitsi/tpl/archive/refs/tags/v1.5.0.tar.gz /tmp/tpl.tar.gz
RUN tar -xzf /tmp/tpl.tar.gz --strip-components=1 \
    && go get golang.org/x/crypto@v0.58.0 golang.org/x/text@v0.43.0 \
    && go mod verify \
    && go test ./... \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tpl .

FROM ${BUILD_BASE} AS step-build
WORKDIR /src
ADD --checksum=sha256:0c8562b95150cc24bf69ba18fcf9f0bf671f334f5d3ccb39f287692b61531b7c \
    https://github.com/smallstep/cli/archive/refs/tags/v0.30.6.tar.gz /tmp/step.tar.gz
RUN tar -xzf /tmp/step.tar.gz --strip-components=1 \
    && go get golang.org/x/crypto@v0.58.0 golang.org/x/text@v0.43.0 \
      golang.org/x/net@v0.60.0 google.golang.org/grpc@v1.83.2 \
    && go mod verify \
    && CGO_ENABLED=0 go build -trimpath \
      -ldflags="-s -w -X main.Version=0.30.6-helix-security" -o /out/step ./cmd/step \
    && /out/step version

FROM ${SOURCE_IMAGE} AS packages
USER 0:0
# Keep the upstream application version while applying distribution security fixes.
RUN if command -v apk >/dev/null; then apk upgrade --no-cache; \
    else apt-get update \
      && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
      && rm -rf /var/lib/apt/lists/*; fi
# shortcut: distrust incident anchors until all runtime libraries reject the compromised keys.
RUN sed -i \
      -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt$|!mozilla/emSign_ECC_Root_CA_-_G3.crt|' \
      -e 's|^mozilla/Comodo_AAA_Services_root.crt$|!mozilla/Comodo_AAA_Services_root.crt|' \
      /etc/ca-certificates.conf \
    && update-ca-certificates --fresh \
    && mkdir -p /etc/ssl/helix-empty
ENV NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/helix-empty


# Debian's Java hook can retain entries that update-ca-certificates has removed.
RUN if [ -f /etc/ssl/certs/java/cacerts ]; then \
      for alias in debian:comodo_aaa_services_root.pem debian:emsign_ecc_root_ca_-_g3.pem; do \
        if keytool -list -alias "$alias" -keystore /etc/ssl/certs/java/cacerts -storepass changeit >/dev/null 2>&1; then \
          keytool -delete -alias "$alias" -keystore /etc/ssl/certs/java/cacerts -storepass changeit || exit 1; \
        fi; \
      done; \
    fi

ARG RUNTIME_USER=0:0
USER ${RUNTIME_USER}

FROM packages AS jitsi
COPY --from=tpl-build --chmod=0755 /out/tpl /usr/bin/tpl
# Jicofo and JVB execute Node, but never install npm packages at runtime.
USER 0:0
RUN rm -rf /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx
USER ${RUNTIME_USER}

FROM packages AS mail-edge
COPY --from=step-build --chmod=0755 /out/step /usr/bin/step-cli
