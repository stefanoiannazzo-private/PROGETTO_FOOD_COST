#!/bin/sh
# Avvio del contenitore applicativo: dipendenze, configurazione, database e (facoltativi) dati dimostrativi.
set -e
cd /var/www/html

if [ ! -f .env ]; then
  echo "[foodcost] creo .env da .env.example"
  cp .env.example .env
fi
if [ ! -f vendor/autoload.php ]; then
  echo "[foodcost] composer install"
  composer install --no-interaction --prefer-dist --no-progress
fi
if ! grep -q '^APP_KEY=base64:' .env; then
  php artisan key:generate --force
fi

echo "[foodcost] attendo il database ${DB_HOST}:${DB_PORT:-3306}…"
i=0
until php -r 'new PDO("mysql:host=".getenv("DB_HOST").";port=".(getenv("DB_PORT")?:3306), getenv("DB_USERNAME"), getenv("DB_PASSWORD"));' 2>/dev/null; do
  i=$((i+1)); [ $i -gt 60 ] && { echo "database non raggiungibile"; exit 1; }
  sleep 2
done

php artisan migrate --force
if [ -n "$DEMO_PASSWORD" ] && [ "$(php artisan tinker --execute='echo \DB::table("users")->count();' 2>/dev/null | tail -1)" = "0" ]; then
  echo "[foodcost] carico i dati dimostrativi"
  php artisan foodcost:seed-demo --password="$DEMO_PASSWORD"
fi
mkdir -p storage/framework/cache storage/framework/views storage/logs storage/app/imports storage/app/outbox bootstrap/cache
chown -R www-data:www-data storage bootstrap/cache 2>/dev/null || true

exec "$@"
