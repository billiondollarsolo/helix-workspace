#!/bin/sh

set -eu

baked_rules=/opt/helix-spamassassin-rules/4.000002
active_rules=/var/lib/spamassassin/4.000002

if [ ! -s "${active_rules}/updates_spamassassin_org/72_active.cf" ]; then
  install -d "${active_rules}"
  cp -a "${baked_rules}/." "${active_rules}/"
fi

if [ "$#" -eq 0 ]; then
  set -- /init.sh
fi

exec "$@"
