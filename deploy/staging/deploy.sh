#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
backend_path=${1:?Backend path required}
release_id=${2:?Release ID required}
[[ "$backend_path" =~ ^/opt/[a-zA-Z0-9_/-]+$ && "$backend_path" != */ && "$backend_path" != /opt ]] || exit 2
[[ "$release_id" =~ ^[a-zA-Z0-9-]+$ ]] || exit 2
incoming="/tmp/mujez-backend-$release_id"
release="$backend_path-releases/$release_id"
active="$backend_path/deploy/staging"
candidate="$release/deploy/staging"
exec 9>/var/lock/mujez-staging-backend.lock
flock -w 1200 9
cleanup() { rm -f "$incoming/staging.env"; }
trap cleanup EXIT
test -s "$active/.env" && test -s "$active/admin.env" && test -s "$active/api.env"
test ! -e "$release"
install -d -m 700 "$release"
tar -xzf "$incoming/source.tar.gz" -C "$release"
python3 "$candidate/validate-env.py" "$incoming/staging.env" "$active/api.env"
install -m 600 "$incoming/staging.env" "$candidate/api.env"
install -m 600 "$active/admin.env" "$candidate/admin.env"
sed '/^API_IMAGE=/d' "$active/.env" > "$candidate/.env"
printf 'API_IMAGE=mujez-staging-api:%s\n' "$release_id" >> "$candidate/.env"
dc() { docker compose --project-directory "$candidate" -f "$candidate/compose.yaml" "$@"; }
old_dc() { docker compose --project-directory "$active" -f "$active/compose.yaml" "$@"; }
dc config --quiet
dc build api
docker run --rm --env-file "$candidate/api.env" "mujez-staging-api:$release_id" \
  node --input-type=module -e "import {parseEnvironment} from './dist/config/env.js'; parseEnvironment(process.env); console.log('Application environment validated')"

# A failed backup or migration stops deployment before the running API changes.
backup_dir="$(dirname "$backend_path")/backups"
install -d -m 700 "$backup_dir"
old_dc exec -T postgres pg_dump -U mujez_owner -d mujez -Fc > "$backup_dir/$release_id.dump"
test -s "$backup_dir/$release_id.dump"
dc run --rm -T --interactive=false maintenance node scripts/migrate.mjs

if ! dc up -d --no-build --wait --wait-timeout 120 api; then
  echo 'New API failed readiness; restoring previous API image and environment.' >&2
  old_dc up -d --no-build --force-recreate --wait --wait-timeout 120 api
  echo 'Database migrations are not automatically reversed. Use backward-compatible migrations.' >&2
  exit 1
fi

# Keep the original installation as a release on the first CI deployment.
if [[ ! -L "$backend_path" ]]; then
  mv "$backend_path" "$backend_path-releases/initial-$release_id"
fi
ln -s "$release" "$backend_path-next-$release_id"
mv -Tf "$backend_path-next-$release_id" "$backend_path"
echo "Backend release $release_id deployed and ready"
