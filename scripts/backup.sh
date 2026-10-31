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

# ── Kirim salinan ke luar VPS (offsite) ──────────────────────────────────────
# Bila VPS rusak, backup di folder backups/ ikut hilang. Salinan dienkripsi
# (AES-256, kunci BACKUP_PASSPHRASE) lalu dikirim ke:
#   • Telegram (BACKUP_TELEGRAM_CHAT_ID + TELEGRAM_BOT_TOKEN) — tanpa pasang apa pun
#   • rclone (BACKUP_RCLONE_REMOTE, mis. "gdrive:MainGypsumBackup") — opsional
# Gagal kirim tidak menggagalkan backup lokal, tapi keluar dengan kode 2 agar terlihat di log cron.
OFFSITE_FAIL=0
if [ -n "${BACKUP_TELEGRAM_CHAT_ID:-}${BACKUP_RCLONE_REMOTE:-}" ]; then
  if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
    echo "OFFSITE DILEWATI: BACKUP_PASSPHRASE belum diisi di .env (backup tidak dikirim tanpa enkripsi)" >&2
    exit 2
  fi
  OUT="backups/offsite-$STAMP"
  mkdir -p "$OUT"
  for f in "$FILE" "backups/mg-erp-files-$STAMP.tar.gz"; do
    [ -f "$f" ] || continue
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE -in "$f" -out "$OUT/$(basename "$f").enc"
  done
  # Telegram bot hanya menerima file ≤ 50 MB: pecah per 45 MB
  ( cd "$OUT" && for f in *.enc; do
      if [ "$(stat -c %s "$f")" -gt 47185920 ]; then split -b 45M -d -a 2 "$f" "$f.part"; rm -f "$f"; fi
    done )
  if [ -n "${BACKUP_TELEGRAM_CHAT_ID:-}" ]; then
    : "${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN belum diatur}"
    for f in "$OUT"/*; do
      if curl -sS -f -o /dev/null --max-time 300 \
        -F chat_id="$BACKUP_TELEGRAM_CHAT_ID" \
        -F caption="Backup ERP Main Gypsum $STAMP ($(basename "$f"))" \
        -F document=@"$f" \
        "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument"; then
        echo "Terkirim ke Telegram: $(basename "$f")"
      else
        echo "GAGAL kirim ke Telegram: $(basename "$f")" >&2; OFFSITE_FAIL=1
      fi
    done
  fi
  if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
    if command -v rclone >/dev/null 2>&1 && rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE/$STAMP"; then
      echo "Tersalin ke $BACKUP_RCLONE_REMOTE/$STAMP"
      # Simpan 30 hari di remote
      rclone delete --min-age 30d "$BACKUP_RCLONE_REMOTE" >/dev/null 2>&1 || true
    else
      echo "GAGAL salin ke rclone ($BACKUP_RCLONE_REMOTE)" >&2; OFFSITE_FAIL=1
    fi
  fi
  rm -rf "$OUT"
fi
[ "$OFFSITE_FAIL" = 0 ] || exit 2
