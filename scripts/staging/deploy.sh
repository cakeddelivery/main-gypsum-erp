#!/usr/bin/env bash
# Pasang sebuah cabang (fitur baru) ke staging untuk dicek. Produksi tidak tersentuh.
# Pakai: bash scripts/staging/deploy.sh <nama-cabang>   (tanpa nama = main)
set -euo pipefail
. "$(dirname "$0")/common.sh"
BRANCH="${1:-main}"
require_staging
cd "$STAGING_DIR"

echo "== Ambil cabang $BRANCH"
git fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git checkout --quiet -f -B "$BRANCH" "origin/$BRANCH"
git log --oneline -1

npm ci --no-audit --no-fund
npx prisma migrate deploy
npm run build
pm2 restart "$STAGING_PM2" --update-env
echo
echo "Staging sekarang menjalankan cabang $BRANCH: https://$STAGING_DOMAIN"
