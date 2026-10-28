#!/usr/bin/env bash
# Siapkan database KHUSUS TEST yang bersih: buat ulang DB lokal *_test, terapkan migrasi, isi data awal.
# Pengaman: hanya berjalan untuk host localhost dan nama database berakhiran _test.
set -euo pipefail
export DATABASE_URL="${TEST_DATABASE_URL:-postgresql://mg:mg@localhost:5432/mg_erp_test}"
DB_NAME="${DATABASE_URL##*/}"; DB_NAME="${DB_NAME%%\?*}"
[[ "$DATABASE_URL" == *"@localhost:"* && "$DB_NAME" == *_test ]] || { echo "Menolak: bukan database test lokal" >&2; exit 1; }
ADMIN_URL="${DATABASE_URL%/*}/postgres"
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" -c "CREATE DATABASE \"$DB_NAME\";"
npx prisma migrate deploy >/dev/null
npx tsx prisma/seed.ts >/dev/null
