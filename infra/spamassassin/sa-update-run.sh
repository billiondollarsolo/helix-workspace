#!/bin/sh
# runit service replacing the upstream root crontab: refresh rules daily as the
# unprivileged spamd account and reload spamd when sa-update installed updates
# (exit 0; exit 1 means none were available).
exec 2>&1

pidfile=/run/spamd/spamd.pid

while sleep 86400; do
  if sa-update; then
    echo "Updated SpamAssassin rules"
    if [ -s "${pidfile}" ]; then
      kill -HUP "$(cat "${pidfile}")" || true
    fi
  fi
done
