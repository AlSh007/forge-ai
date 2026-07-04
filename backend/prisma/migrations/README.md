# Prisma migrations

Deploys now run `prisma migrate deploy` (see `render.yaml`) instead of the
destructive `prisma db push --accept-data-loss`. This gives versioned, reviewable
schema changes and removes the risk of a deploy silently dropping columns/data.

## Migrations

- `0_init` — baseline. Matches the schema that was originally created on the
  production database via `db push`. Contains no changes to apply to prod.
- `0001_add_execution_indexes` — adds indexes on `AgentExecution.taskId` and
  `ExecutionLog.taskId` (both are queried by `taskId` on every task-detail load).

## ONE-TIME baseline step for the existing production database (required once)

The production Supabase database already has all tables (they were created by the
old `db push`). Running `migrate deploy` against it directly would fail with
`P3005: the database schema is not empty` because Prisma has no record of `0_init`
ever being applied.

Before the next deploy, mark the baseline as already-applied **once**, against prod:

```bash
# Run locally with the production DATABASE_URL / DIRECT_URL exported,
# or from a Render shell.
npx prisma migrate resolve \
  --applied 0_init \
  --schema=backend/prisma/schema.prisma
```

After that, every deploy runs `migrate deploy`, which will apply `0001_...` (the
indexes) and any future migrations. No further manual steps.

## Creating new migrations going forward

```bash
# Edits schema.prisma, then:
npm run migrate -w backend   # prisma migrate dev — creates + applies locally
```

Commit the generated folder under `migrations/`. Do not use `db push` on any
shared/production database again.
