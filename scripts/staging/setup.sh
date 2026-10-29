#!/usr/bin/env bash
# Sekali saja: siapkan staging terpisah (folder, database, .env, PM2, Nginx) di VPS yang sama.
# Pakai: bash scripts/staging/setup.sh produksi   (salin data produksi)
#        bash scripts/staging/setup.sh contoh     (data contoh/seed)
set -euo pipefail
. "$(dirname "$0")/common.sh"
DATA="${1:-produksi}"
[ "$DATA" = "produksi" ] || [ "$DATA" = "contoh" ] || { echo "Pakai: bash scripts/staging/setup.sh produksi|contoh"; exit 1; }
[ -f "$PROD_DIR/.env" ] || { echo "Tidak menemukan $PROD_DIR/.env"; exit 1; }
[ ! -e "$STAGING_DIR" ] || { echo "$STAGING_DIR sudah ada. Untuk update pakai: bash scripts/staging/deploy.sh <cabang>"; exit 1; }

echo "== 1/6 Salin kode ke $STAGING_DIR"
git clone --quiet "$PROD_DIR" "$STAGING_DIR"
git -C "$STAGING_DIR" remote set-url origin "$(git -C "$PROD_DIR" remote get-url origin)"
git -C "$STAGING_DIR" fetch --quiet origin main
git -C "$STAGING_DIR" checkout --quiet -B main origin/main

echo "== 2/6 Buat database $STAGING_DB (minta password sudo)"
DB_PASS="$(openssl rand -hex 24)"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
CREATE ROLE $STAGING_DB_USER LOGIN PASSWORD '$DB_PASS';
CREATE DATABASE $STAGING_DB OWNER $STAGING_DB_USER;
SQL

echo "== 3/6 Tulis .env staging (rahasia dibuat otomatis, tidak ditampilkan)"
umask 077
{
  echo "APP_URL=\"https://$STAGING_DOMAIN\""
  echo "DATABASE_URL=\"postgresql://$STAGING_DB_USER:$DB_PASS@localhost:5432/$STAGING_DB\""
  echo "AUTH_SECRET=\"$(openssl rand -hex 32)\""
  echo "APP_ENV=\"staging\""
  echo "STORAGE_DIR=\"./storage/private\""
  echo "# Jadwal otomatis & Telegram sengaja dimatikan di staging"
  echo "CRON_SECRET=\"\""
  echo "TELEGRAM_BOT_TOKEN=\"\""
  echo "TELEGRAM_WEBHOOK_SECRET=\"\""
  echo "HERMES_WEBHOOK_URL=\"\""
  echo "HERMES_WEBHOOK_TOKEN=\"\""
  # AI (baca struk & advisor) memakai kunci yang sama dengan produksi
  for k in ANTHROPIC_API_KEY AI_BASE_URL AI_API_KEY AI_MODEL; do
    echo "$k=\"$(env_get "$PROD_DIR/.env" "$k")\""
  done
} > "$STAGING_DIR/.env"
umask 022

echo "== 4/6 Install & isi database ($DATA)"
cd "$STAGING_DIR"
npm ci --no-audit --no-fund
npx prisma migrate deploy
if [ "$DATA" = "produksi" ]; then
  bash "$STAGING_DIR/scripts/staging/refresh-data.sh" --yes
else
  npm run db:seed
fi
npm run build

echo "== 5/6 Jalankan di PM2 ($STAGING_PM2, port $STAGING_PORT, tanpa penjadwal)"
pm2 start "$STAGING_DIR/node_modules/next/dist/bin/next" --name "$STAGING_PM2" --cwd "$STAGING_DIR" -- start -p "$STAGING_PORT" -H 127.0.0.1
pm2 save

echo "== 6/6 Pasang Nginx untuk $STAGING_DOMAIN"
sudo tee /etc/nginx/sites-available/maingypsum-staging >/dev/null <<NGINX
server {
    listen 80;
    server_name $STAGING_DOMAIN;
    client_max_body_size 20m;
    # Jangan sampai staging muncul di Google
    add_header X-Robots-Tag "noindex, nofollow" always;
    location / {
        proxy_pass http://127.0.0.1:$STAGING_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/maingypsum-staging /etc/nginx/sites-enabled/maingypsum-staging
sudo nginx -t && sudo systemctl reload nginx

echo
echo "Staging siap di port $STAGING_PORT. Langkah terakhir (sekali): pasang SSL"
echo "  sudo certbot --nginx -d $STAGING_DOMAIN"
echo "Lalu buka https://$STAGING_DOMAIN (ada banner kuning LINGKUNGAN STAGING)."
