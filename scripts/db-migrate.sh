#!/bin/sh
# Idempotent database migration for deploys.
#
# Handles three cases automatically so no manual baseline step is ever needed:
#
#   1. Existing production DB created by the old `db push` (tables exist, but no
#      Prisma migration history). `migrate status` reports P3005. We baseline by
#      marking 0_init as already-applied (records history WITHOUT re-running its
#      SQL), then `migrate deploy` applies everything after it (e.g. indexes).
#   2. Already-baselined DB (normal subsequent deploys). No P3005 → skip baseline,
#      `migrate deploy` applies any pending migrations (a no-op when up to date).
#   3. Fresh/empty DB (e.g. a new environment). Not P3005 → skip baseline,
#      `migrate deploy` creates the migrations table and applies 0_init onward.
#
# The baseline branch triggers ONLY on P3005, so a fresh DB is never mis-baselined.
set -eu

SCHEMA=backend/prisma/schema.prisma
BASELINE=0_init

if npx prisma migrate status --schema="$SCHEMA" 2>&1 | grep -q "P3005"; then
  echo "[db-migrate] Existing non-empty database with no migration history detected."
  echo "[db-migrate] Baselining '$BASELINE' as already-applied (one time)…"
  npx prisma migrate resolve --applied "$BASELINE" --schema="$SCHEMA"
fi

echo "[db-migrate] Applying pending migrations…"
npx prisma migrate deploy --schema="$SCHEMA"
