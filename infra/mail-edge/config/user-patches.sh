#!/usr/bin/env bash
set -Eeuo pipefail

ingest_host=${HELIX_MAIL_INGEST_HOST:?missing HELIX_MAIL_INGEST_HOST}
ingest_port=${HELIX_MAIL_INGEST_PORT:?missing HELIX_MAIL_INGEST_PORT}
[[ "$ingest_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || {
  echo "invalid HELIX_MAIL_INGEST_HOST" >&2
  exit 1
}
[[ "$ingest_port" =~ ^[0-9]+$ ]] && ((ingest_port >= 1 && ingest_port <= 65535)) || {
  echo "invalid HELIX_MAIL_INGEST_PORT" >&2
  exit 1
}

relay_domains=/etc/postfix/helix-relay-domains
transport_maps=/etc/postfix/helix-transport
: >"$relay_domains"
: >"$transport_maps"
IFS=',' read -ra domains <<<"${HELIX_MAIL_RELAY_DOMAINS:?missing HELIX_MAIL_RELAY_DOMAINS}"
for domain in "${domains[@]}"; do
  domain=${domain//[[:space:]]/}
  domain=${domain,,}
  [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || {
    echo "invalid relay domain: $domain" >&2
    exit 1
  }
  printf '%s OK\n' "$domain" >>"$relay_domains"
  printf '%s smtp:[%s]:%s\n' "$domain" "$ingest_host" "$ingest_port" >>"$transport_maps"
done

sort -u -o "$relay_domains" "$relay_domains"
sort -u -o "$transport_maps" "$transport_maps"
chmod 0644 "$relay_domains" "$transport_maps"
postconf -e "relay_domains = texthash:$relay_domains"
postconf -e "transport_maps = texthash:$transport_maps"
postconf -M# submission/inet
postconf -M# submissions/inet
postfix check
