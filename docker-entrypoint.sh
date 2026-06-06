#!/bin/sh
set -e

echo "[entrypoint] Waiting for PostgreSQL to accept connections..."
until pg_isready -h postgres -p 5432 -U laitor > /dev/null 2>&1; do
  echo "[entrypoint] Not ready yet — retrying in 2s..."
  sleep 2
done
echo "[entrypoint] pg_isready passed."

# Extra wait — pg_isready can pass before the DB/user is fully created
echo "[entrypoint] Verifying database is accessible..."
RETRIES=15
i=0
until PGPASSWORD=laitor_secret psql -h postgres -U laitor -d laitor -c "SELECT 1" > /dev/null 2>&1; do
  i=$((i+1))
  if [ $i -ge $RETRIES ]; then
    echo "[entrypoint] ERROR: Could not connect to database after $RETRIES attempts."
    echo "[entrypoint] Check that POSTGRES_DB=laitor, POSTGRES_USER=laitor, POSTGRES_PASSWORD=laitor_secret"
    exit 1
  fi
  echo "[entrypoint] Database not accessible yet ($i/$RETRIES) — retrying in 2s..."
  sleep 2
done
echo "[entrypoint] Database is accessible."

echo "[entrypoint] Running migration..."
node src/models/migrate.js
echo "[entrypoint] Migration complete. Starting app..."
exec node src/index.js
