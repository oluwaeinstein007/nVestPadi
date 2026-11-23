#!/bin/sh
# Container entrypoint.
#
# When LITESTREAM_BUCKET is set, the SQLite database is restored from S3-compatible storage on boot
# and replicated continuously (~1s) while the app runs, so accounts and alerts survive hosts whose
# disk is wiped on restart (e.g. Render's free plan). Without it, the app runs exactly as before.
set -eu

if [ -z "${LITESTREAM_BUCKET:-}" ]; then
	exec "$@"
fi

: "${LITESTREAM_ACCESS_KEY_ID:?LITESTREAM_BUCKET is set but LITESTREAM_ACCESS_KEY_ID is missing}"
: "${LITESTREAM_SECRET_ACCESS_KEY:?LITESTREAM_BUCKET is set but LITESTREAM_SECRET_ACCESS_KEY is missing}"
export LITESTREAM_PATH="${LITESTREAM_PATH:-nvestpadi}"
export LITESTREAM_ENDPOINT="${LITESTREAM_ENDPOINT:-}"
export LITESTREAM_REGION="${LITESTREAM_REGION:-}"

echo "litestream: restoring ${DATABASE_PATH} from s3://${LITESTREAM_BUCKET}/${LITESTREAM_PATH} (if a replica exists)"
# Fails loudly on bad credentials rather than starting with an empty database.
litestream restore -config /etc/litestream.yml -if-db-not-exists -if-replica-exists "$DATABASE_PATH"

# Litestream takes the command as one string (parsed like a shell would), so quote every argument
# to keep ones containing spaces or quotes intact.
cmd=""
for arg in "$@"; do
	cmd="$cmd '$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")'"
done

# Litestream supervises the app: it forwards signals and does a final sync when the app exits.
exec litestream replicate -config /etc/litestream.yml -exec "$cmd"
