#!/usr/bin/env bash
# Backup database (pg_dump format custom) ke ./backups, simpan 14 hari terakhir.
set -euo pipefail
cd "$(dirname "$0")/.."
# Muat .env bila DATABASE_URL belum ada di environment (mis. dijalankan dari cron)
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL belum diatur}"
# File backup berisi data gaji & keuangan: hanya bisa dibaca pemilik
umask 077
mkdir -p backups
chmod 700 backups
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="backups/mg-erp-$STAMP.dump"
pg_dump --format=custom --no-owner "${DATABASE_URL%%\?*}" > "$FILE"
echo "Backup tersimpan: $FILE"
# Foto bukti transaksi & foto checklist laporan (tidak ada di database)
STORAGE="${STORAGE_DIR:-./storage/private}"
if [ -d "$STORAGE" ]; then
  tar -czf "backups/mg-erp-files-$STAMP.tar.gz" -C "$(dirname "$STORAGE")" "$(basename "$STORAGE")"
  echo "Backup file bukti: backups/mg-erp-files-$STAMP.tar.gz"
fi
find backups \( -name 'mg-erp-*.dump' -o -name 'mg-erp-files-*.tar.gz' \) -mtime +14 -delete
