#!/usr/bin/env bash
# Update PRODUKSI dari main dengan build hemat memori (VPS 3,6 GB RAM).
# Pakai: cd ~/main-gypsum-erp && npm run update:prod
# Urutan: git pull → backup → npm ci → migrasi → stop staging → build ringan ke folder sementara → tukar .next → restart pm2.
# Situs tetap jalan selama build (build ditulis ke .next-baru, baru ditukar setelah berhasil). Berhenti di langkah yang gagal.
set -euo pipefail
cd "$(dirname "$0")/.."

STEP=""
step() { STEP="$1"; echo; echo "== $1"; }
fail() {
  echo
  echo "!! GAGAL di langkah: $STEP"
  echo "   Produksi masih memakai build lama (.next) kecuali langkah gagal sesudah penukaran."
  if [ -d .next-lama ] && [ "$STEP" = "Restart aplikasi" ]; then
    echo "   Kembalikan build lama: rm -rf .next && mv .next-lama .next && pm2 restart maingypsum maingypsum-jadwal --update-env"
  fi
  exit 1
}
trap fail ERR

step "Ambil kode terbaru (git pull origin main)"
git pull --ff-only origin main

step "Backup database (npm run backup)"
npm run backup

step "Pasang dependensi (npm ci)"
npm ci --no-audit --no-fund

step "Migrasi database (prisma migrate deploy)"
npx prisma migrate deploy

step "Hentikan staging agar RAM cukup untuk build"
if pm2 describe maingypsum-staging >/dev/null 2>&1; then
  pm2 stop maingypsum-staging
  echo "   staging dihentikan (nyalakan lagi bila perlu: pm2 start maingypsum-staging)"
else
  echo "   staging tidak ada, dilewati"
fi

step "Build ringan ke folder sementara (.next-baru)"
rm -rf .next-baru
NEXT_DIST_DIR=.next-baru npm run build:ringan
[ -f .next-baru/BUILD_ID ] || { echo "   Build tidak menghasilkan .next-baru/BUILD_ID"; false; }

step "Tukar build (.next-baru → .next; build lama disimpan di .next-lama)"
rm -rf .next-lama
if [ -d .next ]; then mv .next .next-lama; fi
mv .next-baru .next

step "Restart aplikasi"
pm2 restart maingypsum maingypsum-jadwal --update-env

STEP="selesai"
trap - ERR
echo
echo "== Selesai. Produksi sekarang menjalankan:"
git log -1 --oneline
echo "   (build lama ada di .next-lama; boleh dihapus: rm -rf .next-lama)"
