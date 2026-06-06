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
    echo "[boot] ERROR: laitor_db:5432 never opened after $RETRIES attempts."
    exit 1
  fi
  echo "[boot] Attempt $i/$RETRIES — retrying in 3s..."
  sleep 3
done
echo "[boot] laitor_db is reachable. Waiting 3s for full init..."
sleep 3

# Run DB migration
echo "[boot] Running database migration..."
node src/models/migrate.js
echo "[boot] Migration complete."

# Start app
echo "[boot] Starting app on port 3000..."
exec node src/index.js
