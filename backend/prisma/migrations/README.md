# Prisma migrations

Deploys now run `prisma migrate deploy` (see `render.yaml`) instead of the
destructive `prisma db push --accept-data-loss`. This gives versioned, reviewable
schema changes and removes the risk of a deploy silently dropping columns/data.

## Migrations

- `0_init` — baseline. Matches the schema that was originally created on the
  production database via `db push`. Contains no changes to apply to prod.
- `0001_add_execution_indexes` — adds indexes on `AgentExecution.taskId` and
  `ExecutionLog.taskId` (both are queried by `taskId` on every task-detail load).

## Baselining is automated — no manual step required

The production Supabase database already has all tables (created by the old
`db push`), so a plain `migrate deploy` against it would fail with
`P3005: the database schema is not empty` — Prisma has no record of `0_init`
being applied.

This is handled automatically by `scripts/db-migrate.sh`, which the Render
`startCommand` runs on every deploy (see `render.yaml`). On the first deploy it
detects P3005, marks `0_init` as already-applied (baseline), then runs
`migrate deploy` to apply `0001_...` and anything after. On later deploys it just
runs `migrate deploy`. The baseline branch triggers only on P3005, so a fresh/empty
database is never mis-baselined.

If you ever need to baseline a database by hand (e.g. a one-off environment):

```bash
# With that database's DATABASE_URL / DIRECT_URL exported:
npx prisma migrate resolve --applied 0_init --schema=backend/prisma/schema.prisma
npx prisma migrate deploy --schema=backend/prisma/schema.prisma
```

## Creating new migrations going forward

```bash
# Edits schema.prisma, then:
npm run migrate -w backend   # prisma migrate dev — creates + applies locally
```

Commit the generated folder under `migrations/`. Do not use `db push` on any
shared/production database again.
