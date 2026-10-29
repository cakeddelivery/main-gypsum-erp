#!/usr/bin/env bash
# Timpa database & foto bukti staging dengan salinan terbaru dari produksi.
# Produksi hanya DIBACA (pg_dump), tidak pernah diubah.
# Pakai: bash scripts/staging/refresh-data.sh
set -euo pipefail
. "$(dirname "$0")/common.sh"
require_staging
PROD_URL="$(env_get "$PROD_DIR/.env" DATABASE_URL)"
STG_URL="$(env_get "$STAGING_DIR/.env" DATABASE_URL)"
[ -n "$PROD_URL" ] && [ -n "$STG_URL" ] || { echo "DATABASE_URL tidak ditemukan"; exit 1; }
[ "${PROD_URL%%\?*}" != "${STG_URL%%\?*}" ] || { echo "BERHENTI: database staging sama dengan produksi"; exit 1; }

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Data staging akan DIGANTI salinan produksi. Ketik YA untuk lanjut: " ok
  [ "$ok" = "YA" ] || { echo "Dibatalkan"; exit 1; }
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "== Salin database produksi"
pg_dump --format=custom --no-owner --no-privileges "${PROD_URL%%\?*}" > "$TMP/prod.dump"
psql -q -v ON_ERROR_STOP=1 "${STG_URL%%\?*}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
pg_restore --no-owner --no-privileges --dbname="${STG_URL%%\?*}" "$TMP/prod.dump"

echo "== Salin foto bukti"
PROD_STORAGE="$(storage_dir "$PROD_DIR")"
STG_STORAGE="$(storage_dir "$STAGING_DIR")"
[ "$PROD_STORAGE" != "$STG_STORAGE" ] || { echo "BERHENTI: folder foto staging sama dengan produksi"; exit 1; }
rm -rf "$STG_STORAGE"
mkdir -p "$STG_STORAGE"
[ -d "$PROD_STORAGE" ] && cp -a "$PROD_STORAGE"/. "$STG_STORAGE"/

# Cabang yang sedang dipasang di staging mungkin punya migrasi baru
cd "$STAGING_DIR" && npx prisma migrate deploy
echo "Data staging sudah sama dengan produksi per $(date '+%d-%m-%Y %H:%M')."
