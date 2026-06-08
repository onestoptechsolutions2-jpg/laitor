#!/bin/sh
set -e

echo "============================================"
echo "  LAITOR WHATSAPP ENGINE — Starting up"
echo "============================================"

# Wait for laitor_db port to be open
echo "[boot] Waiting for laitor_db:5432..."
RETRIES=40
i=0
until nc -z laitor_db 5432 2>/dev/null; do
  i=$((i+1))
  if [ $i -ge $RETRIES ]; then
    echo "[boot] ERROR: laitor_db not reachable after ${RETRIES} attempts"
    exit 1
  fi
  echo "[boot] Attempt $i/$RETRIES — retrying in 3s..."
  sleep 3
done
echo "[boot] laitor_db is up."

# Run database migration (idempotent — safe on every start)
echo "[boot] Running database migration..."
node src/models/migrate.js
echo "[boot] Migration complete."

# Start the application
echo "[boot] Starting application..."
exec node src/index.js
