#!/bin/sh
# Idempotent database migration for deploys.
#
# Handles three cases automatically so no manual baseline step is ever needed:
#
#   1. Existing production DB created by the old `db push` (tables exist, but no
#      Prisma migration history). `migrate deploy` fails with P3005. We then
#      baseline by marking 0_init as already-applied (records history WITHOUT
#      re-running its SQL) and deploy again — applying everything after it.
#   2. Already-baselined DB (normal subsequent deploys). `migrate deploy` succeeds
#      and applies any pending migrations (a no-op when up to date).
#   3. Fresh/empty DB (e.g. a new environment). `migrate deploy` succeeds and
#      applies 0_init onward — it never hits P3005, so it is never mis-baselined.
#
# Detection is based on P3005 from `migrate deploy` itself (which reliably emits
# it), NOT on `migrate status` output.
set -eu

SCHEMA=backend/prisma/schema.prisma
BASELINE=0_init

echo "[db-migrate] Applying pending migrations…"
# Run deploy; capture output so we can inspect it without aborting under `set -e`.
if OUTPUT=$(npx prisma migrate deploy --schema="$SCHEMA" 2>&1); then
  echo "$OUTPUT"
  echo "[db-migrate] Migrations up to date."
  exit 0
fi

echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "P3005"; then
  echo "[db-migrate] Existing non-empty database with no migration history."
  echo "[db-migrate] Baselining '$BASELINE' as already-applied (one time)…"
  npx prisma migrate resolve --applied "$BASELINE" --schema="$SCHEMA"
  echo "[db-migrate] Re-running migrate deploy…"
  npx prisma migrate deploy --schema="$SCHEMA"
else
  echo "[db-migrate] migrate deploy failed for a non-P3005 reason; aborting."
  exit 1
fi
