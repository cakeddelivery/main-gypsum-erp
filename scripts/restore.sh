#!/usr/bin/env bash
# Pulihkan backup ke DATABASE_URL tujuan. PERINGATAN: menimpa objek yang ada. Uji di staging dahulu.
set -euo pipefail
# Muat .env bila DATABASE_URL belum ada di environment (mis. dijalankan dari cron)
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL belum diatur}"
FILE="${1:?Pakai: npm run restore -- backups/<file>.dump}"
. "$(dirname "$0")/lib/pg-env.sh"
# Password database lewat environment, bukan argumen (tidak terlihat di `ps`)
pg_env_from_url "$DATABASE_URL"
read -r -p "Pulihkan $FILE ke database $PGDATABASE di $PGHOST:$PGPORT (user $PGUSER)? Ketik YA untuk lanjut: " ok
[ "$ok" = "YA" ] || { echo "Dibatalkan"; exit 1; }
pg_restore --clean --if-exists --no-owner --dbname="$PGDATABASE" "$FILE"
echo "Pemulihan selesai"
