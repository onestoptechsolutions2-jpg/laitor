#!/bin/sh
set -e

echo "[entrypoint] Waiting for PostgreSQL..."
until pg_isready -h postgres -p 5432 -U laitor > /dev/null 2>&1; do
  echo "[entrypoint] PostgreSQL not ready yet — retrying in 2s..."
  sleep 2
done
echo "[entrypoint] PostgreSQL is ready."

echo "[entrypoint] Running database migration..."
node src/models/migrate.js
echo "[entrypoint] Migration complete."

echo "[entrypoint] Starting Laitor WhatsApp Engine on port 3000..."
exec node src/index.js
