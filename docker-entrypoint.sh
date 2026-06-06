#!/bin/sh
set -e

echo "[entrypoint] Waiting for PostgreSQL at postgres:5432..."
RETRIES=30
i=0
until pg_isready -h postgres -p 5432 -U laitor > /dev/null 2>&1; do
  i=$((i+1))
  if [ $i -ge $RETRIES ]; then
    echo "[entrypoint] ERROR: PostgreSQL never became ready after ${RETRIES} attempts."
    exit 1
  fi
  echo "[entrypoint] Attempt $i/$RETRIES — waiting 3s..."
  sleep 3
done

echo "[entrypoint] PostgreSQL is ready. Waiting 5s for full init..."
sleep 5

echo "[entrypoint] Running migration..."
node src/models/migrate.js
STATUS=$?

if [ $STATUS -ne 0 ]; then
  echo "[entrypoint] Migration exited with code $STATUS — aborting."
  exit $STATUS
fi

echo "[entrypoint] Migration done. Starting app..."
exec node src/index.js
