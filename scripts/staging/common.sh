#!/usr/bin/env bash
# Pengaturan bersama skrip staging. Bisa diubah lewat environment bila folder/port berbeda.
PROD_DIR="${PROD_DIR:-$HOME/main-gypsum-erp}"
STAGING_DIR="${STAGING_DIR:-$HOME/main-gypsum-erp-staging}"
STAGING_DOMAIN="${STAGING_DOMAIN:-tes.maingypsum.shop}"
STAGING_PORT="${STAGING_PORT:-3001}"
STAGING_PM2="${STAGING_PM2:-maingypsum-staging}"
STAGING_DB="${STAGING_DB:-maingypsum_staging}"
STAGING_DB_USER="${STAGING_DB_USER:-mgerp_staging}"

# Baca satu variabel dari file .env tanpa menampilkannya
env_get() {
  local file="$1" key="$2"
  (set -a; . "$file"; set +a; printf '%s' "${!key:-}")
}

# Lokasi absolut folder foto bukti sebuah instalasi
storage_dir() {
  local dir="$1" rel
  rel="$(env_get "$dir/.env" STORAGE_DIR)"
  (cd "$dir" && realpath -m "${rel:-./storage/private}")
}

# Pastikan folder staging benar-benar staging, supaya skrip tidak pernah menyentuh produksi
require_staging() {
  [ -f "$STAGING_DIR/.env" ] || { echo "Folder staging belum disiapkan ($STAGING_DIR). Jalankan dulu: bash scripts/staging/setup.sh"; exit 1; }
  [ "$(env_get "$STAGING_DIR/.env" APP_ENV)" = "staging" ] || { echo "BERHENTI: $STAGING_DIR/.env bukan APP_ENV=staging"; exit 1; }
  [ "$(cd "$STAGING_DIR" && pwd -P)" != "$(cd "$PROD_DIR" && pwd -P)" ] || { echo "BERHENTI: folder staging sama dengan produksi"; exit 1; }
}
