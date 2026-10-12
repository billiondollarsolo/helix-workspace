#!/bin/sh -e
# runit service for spamd, adapted from the upstream image to run as the
# unprivileged spamd account: no -u/-g privilege drop, a pidfile under
# /run/spamd, and network settings written to files the account owns.
exec 2>&1

pidfile=/run/spamd/spamd.pid
config=/etc/mail/spamassassin

rm -f "${pidfile}"

sa-update && echo "Updated SpamAssassin rules" || echo "SpamAssassin rules up-to-date"

if [ -n "${TRUSTED_NETWORKS:-}" ]; then
  echo "Applying TRUSTED_NETWORKS"
  echo "trusted_networks ${TRUSTED_NETWORKS}" >"${config}/trusted_networks.cf"
else
  : >"${config}/trusted_networks.cf"
fi

if [ -n "${INTERNAL_NETWORKS:-}" ]; then
  echo "Applying INTERNAL_NETWORKS"
  echo "internal_networks ${INTERNAL_NETWORKS}" >"${config}/internal_networks.cf"
else
  : >"${config}/internal_networks.cf"
fi

if [ "${DNS_CHECKS:-0}" = "true" ] || [ "${DNS_CHECKS:-0}" = "1" ]; then
  : >"${config}/rdns.cf"
  exec spamd --ip-address --allowed-ips 0.0.0.0/0 --allowed-ips '[::]/0' \
    --syslog stderr --nouser-config --pidfile "${pidfile}"
fi

echo "score RDNS_NONE 0" >"${config}/rdns.cf"
exec spamd --local --ip-address --allowed-ips 0.0.0.0/0 --allowed-ips '[::]/0' \
  --syslog stderr --nouser-config --pidfile "${pidfile}"
