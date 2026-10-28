#!/usr/bin/env bash
# Backup database (pg_dump format custom) ke ./backups, simpan 14 hari terakhir.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL belum diatur}"
mkdir -p backups
FILE="backups/mg-erp-$(date +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner "${DATABASE_URL%%\?*}" > "$FILE"
find backups -name 'mg-erp-*.dump' -mtime +14 -delete
echo "Backup tersimpan: $FILE"
