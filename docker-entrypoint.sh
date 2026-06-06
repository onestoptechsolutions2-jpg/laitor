#!/bin/sh
set -e

echo "[entrypoint] Starting Laitor WhatsApp Engine..."
echo "[entrypoint] DATABASE_URL: ${DATABASE_URL:-NOT SET}"
echo "[entrypoint] REDIS_URL: ${REDIS_URL:-NOT SET}"

echo "[entrypoint] Running database migration..."
node src/models/migrate.js

echo "[entrypoint] Migration complete. Starting app..."
exec node src/index.js
