#!/usr/bin/env bash
set -Eeuo pipefail

config=/etc/nginx/sites-available/mujez-staging
backup=$(mktemp /etc/nginx/sites-available/mujez-staging.XXXXXX)
trap 'rm -f "$backup"' EXIT
cp -p "$config" "$backup"

python3 - "$config" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
source = path.read_text()
marker = 'server_name api-stg.mujez.net;\n    client_max_body_size 6m;'
updated = 'server_name api-stg.mujez.net;\n    client_max_body_size 15m;'
if marker in source:
    path.write_text(source.replace(marker, updated, 1))
elif updated not in source:
    raise SystemExit('Unexpected staging API Nginx configuration; no change applied')
PY

if ! nginx -t; then
  cp -p "$backup" "$config"
  exit 1
fi
if ! systemctl reload nginx; then
  cp -p "$backup" "$config"
  nginx -t
  systemctl reload nginx
  exit 1
fi
