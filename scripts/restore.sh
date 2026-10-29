#!/usr/bin/env bash
# Pulihkan backup ke DATABASE_URL tujuan. PERINGATAN: menimpa objek yang ada. Uji di staging dahulu.
set -euo pipefail
# Muat .env bila DATABASE_URL belum ada di environment (mis. dijalankan dari cron)
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL belum diatur}"
FILE="${1:?Pakai: npm run restore -- backups/<file>.dump}"
read -r -p "Pulihkan $FILE ke ${DATABASE_URL%%@*}@… ? Ketik YA untuk lanjut: " ok
[ "$ok" = "YA" ] || { echo "Dibatalkan"; exit 1; }
pg_restore --clean --if-exists --no-owner --dbname="${DATABASE_URL%%\?*}" "$FILE"
echo "Pemulihan selesai"
