#!/usr/bin/env bash
# Buka file backup offsite (.enc atau potongan .enc.part00, .part01, ...) jadi file asli.
# Pakai: npm run backup:buka -- <file.enc | file.enc.part00>
# Kunci diambil dari BACKUP_PASSPHRASE (.env) atau ditanyakan.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then read -r -s -p "BACKUP_PASSPHRASE: " BACKUP_PASSPHRASE; echo; export BACKUP_PASSPHRASE; fi
IN="${1:?Pakai: npm run backup:buka -- <file.enc atau file.enc.part00>}"
umask 077
case "$IN" in
  *.enc.part*) BASE="${IN%.part*}"; cat "$BASE".part* > "$BASE"; IN="$BASE" ;;
esac
OUT="${IN%.enc}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$IN" -out "$OUT"
echo "Terbuka: $OUT"
echo "Untuk database: npm run restore -- $OUT"
