# ForgeAI

Autonomous AI coding agent platform. Submit a development task and a GitHub repo URL; ForgeAI orchestrates 6 specialized agents (Product Manager → Architect → Database → Backend → Frontend → DevOps) to produce a structured plan, generated code, and optionally a pull request — all visible in real time through a live pipeline dashboard.

## Demo

https://github.com/user-attachments/assets/035f618c-4ec0-43aa-8ac2-15473ddba129

*~23s walkthrough: one task goes in, six agents run down the live pipeline, DevOps returns a verdict, a PR opens. The repo name (`acme/storefront-api`) and the generated code in the video are illustrative stand-ins, not real output.*

Live frontend: https://forge-ai-frontend-seven.vercel.app (sign-in with GitHub required)

## What works today

- **Live agent pipeline** — 6 agents run sequentially; the dashboard polls every 2s and shows each agent's status (pending / running / done / failed) as it changes
- **Real code generation** — Backend and Frontend agents return `{"files": [...]}` JSON with complete file contents; Database agent returns SQL migrations
- **Repo-aware agents** — when repo access is available, agents read the target repo through `read_file`, `list_files` and `search_files` tools before generating
- **Static validation + repair** — generated files are checked deterministically; if errors are found, a repair pass runs and its output is kept only if it reduces the error count
- **Fire-and-forget execution** — `POST /api/tasks/:id/execute` returns 202 immediately; agents run in the background. Tasks can be cancelled (`POST /api/tasks/:id/cancel`) and time out after 10 minutes by default
- **Optional PR creation** — creates a branch, commits all generated files, and opens a PR using the signed-in user's GitHub token (captured at login, encrypted at rest), falling back to `GITHUB_TOKEN`; skipped if neither is available
- **GitHub sign-in** — Supabase auth (GitHub OAuth); every `/api` route requires a valid Supabase JWT and tasks are scoped to their owner
- **Storage** — in-memory in development when `DATABASE_URL` is unset; PostgreSQL via Prisma otherwise. In production the backend refuses to start without a reachable database

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, React 18, Tailwind CSS v3, Zustand, Supabase JS (auth) |
| Backend | Express.js, TypeScript, Prisma + PostgreSQL (optional in dev), express-rate-limit |
| Agent core | Custom `AgentCoordinator` + 6 agent classes |
| LLM | Groq via axios: `llama-3.1-8b-instant` (PM, Architect), `meta-llama/llama-4-scout-17b-16e-instruct` (Database, Backend, Frontend, DevOps), `llama-3.3-70b-versatile` as default |
| Monorepo | npm workspaces (`backend/`, `frontend/`, `agent-core/`) |
| Deploy | Backend on Render (`render.yaml`), frontend on Vercel |

## Quick start

**Prerequisites**: Node.js 18+ (CI uses 20), a [Groq](https://console.groq.com) API key, and a [Supabase](https://supabase.com) project with the GitHub provider enabled (the API rejects requests without a valid Supabase token). Docker is not needed.

```bash
npm install
cp backend/.env.example backend/.env                 # then fill in values
cp frontend/.env.local.example frontend/.env.local   # then fill in values
npm run dev   # builds agent-core, then starts backend :4000 + frontend :3000
```

Minimum for local dev:

- `backend/.env`: `GROQ_API_KEY`, `SUPABASE_URL`, `TOKEN_ENCRYPTION_KEY` (generate with `openssl rand -hex 32`). Leave `DATABASE_URL` unset to use in-memory storage.
- `frontend/.env.local`: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Run one side only:

```bash
npm run build -w agent-core   # required once; backend imports agent-core/dist
npm run dev -w backend        # http://localhost:4000
npm run dev -w frontend       # http://localhost:3000
```

## Agent pipeline

Agents run sequentially. Each receives all prior agents' outputs as context.

| # | Agent | Output |
|---|---|---|
| 1 | Product Manager | Execution plan (plain text) |
| 2 | Architect | Technical design (plain text) |
| 3 | Database | Schema/migration files (`{"files": [...]}`) |
| 4 | Backend | Server-side code (`{"files": [...]}`) |
| 5 | Frontend | UI components (`{"files": [...]}`) |
| 6 | DevOps | Validation report + PASS/FAIL verdict (plain text) |

Between Frontend and DevOps, the generated files go through static validation (with one repair pass if needed); DevOps then reviews the code together with those results. A run passes only if both static validation and the DevOps verdict pass.

## API

All `/api` routes need `Authorization: Bearer <Supabase access token>`. `/health` is public.

```
GET  /health                         System status and storage mode
GET  /api/tasks                      List your tasks (?limit, ?offset)
POST /api/tasks                      Create a task { prompt, repositoryUrl }
GET  /api/tasks/:id                  Get task with executions + logs
POST /api/tasks/:id/execute          Start execution (returns 202 immediately)
POST /api/tasks/:id/cancel           Cancel a running task
GET  /api/executions?taskId=:id      List agent execution records
GET  /api/pull-requests?taskId=:id   List PRs created for a task
POST /api/auth/github                Store the caller's GitHub OAuth token (encrypted)
GET  /api/auth/me                    Current user profile
```

Prompts are limited to 2000 characters and `repositoryUrl` must be a `https://github.com/owner/repo` URL.

## Project structure

```
Forge-AI/
├── agent-core/src/
│   ├── index.ts          AgentCoordinator — sequences agents, threads context, repair pass
│   ├── agents/base.ts    6 agent classes with specialized system prompts
│   ├── llm/client.ts     Groq client (axios, retry/backoff on 429, tool-calling loop)
│   ├── llm/tools.ts      Repo tools: read_file, list_files, search_files
│   ├── validation/static.ts  Deterministic checks on generated files
│   └── types.ts          Shared types: ExecutionContext, CodeChange, RepoContext
├── backend/
│   ├── prisma/           Schema + migrations
│   └── src/
│       ├── index.ts          Express server + all API routes, rate limits, CORS
│       ├── auth.ts           Supabase JWT verification (JWKS)
│       ├── crypto.ts         AES-256-GCM encryption for stored GitHub tokens
│       ├── execution.ts      Task orchestration, real-time storage writes per agent
│       ├── taskControl.ts    In-process cancel/timeout registry
│       ├── storage.ts        Dual adapter: Prisma if DATABASE_URL set, else in-memory
│       └── github.ts         GitHub API: repo context fetch, branch, commit, PR
└── frontend/
    ├── pages/index.tsx        Dashboard: task form + live pipeline + recent tasks
    ├── components/
    │   ├── AgentPipeline.tsx  Live pipeline with animated rail + scan beam
    │   ├── AuthGate.tsx       GitHub sign-in gate (Supabase)
    │   └── TaskForm.tsx       Command-panel style submission form
    └── lib/
        ├── api.ts             Axios client + typed API functions
        ├── store.ts           Zustand store for task state
        └── supabase.ts        Supabase client
```

## Configuration

Names only; see `backend/.env.example` and `frontend/.env.local.example` for templates.

| Variable | Location | Required | Description |
|---|---|---|---|
| `GROQ_API_KEY` | backend | Yes | LLM key from console.groq.com |
| `SUPABASE_URL` | backend | Yes | Supabase project URL; used to verify auth tokens |
| `TOKEN_ENCRYPTION_KEY` | backend | Yes | 32-byte key (hex or base64) for encrypting stored GitHub tokens |
| `DATABASE_URL` | backend | Prod | PostgreSQL; omit in dev for in-memory storage |
| `DIRECT_URL` | backend | With Prisma | Direct DB connection used by Prisma migrations (in `schema.prisma`) |
| `GITHUB_TOKEN` | backend | No | Fallback token for PR creation when a user has none stored |
| `CORS_ORIGIN` | backend | Prod | Allowed frontend origin(s), comma-separated; unset allows all |
| `PORT` | backend | No | Defaults to 4000 |
| `NODE_ENV` | backend | No | `production` enforces a database |
| `RATE_LIMIT_PER_MIN` / `EXECUTE_LIMIT_PER_MIN` | backend | No | API / execute rate limits (default 60 / 10) |
| `TASK_TIMEOUT_MS` | backend | No | Per-task ceiling (default 10 minutes) |
| `NEXT_PUBLIC_API_URL` | frontend | No | Defaults to `http://localhost:4000` |
| `NEXT_PUBLIC_SUPABASE_URL` | frontend | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | frontend | Yes | Supabase anon key |

`backend/.env.example` also lists `GITHUB_APP_ID`, `GITHUB_APP_SECRET`, `DOCKER_HOST` and `LOG_LEVEL`; none of these are read by the current code.

## Commands

```bash
npm run dev               # Start all (builds agent-core first)
npm run build             # Build all workspaces
npm test                  # Run tests in all workspaces
npm run dev -w agent-core # TypeScript watch mode

npm run migrate -w backend       # Run Prisma migrations (dev)
npm run db:push -w backend       # Sync schema without migration
npm run prisma:studio -w backend # Prisma GUI
```

CI (`.github/workflows/ci.yml`) runs install, Prisma generate, build and test on PRs and pushes to `main`. Lint is not a gate yet (no ESLint config).

## Limitations

- Free-tier Groq models have tight rate/token limits; long tasks can hit retries or truncated output (`finish_reason=length`).
- Generated code is statically validated only; it is not executed or tested in a sandbox.
- Execution runs inside the web process, and cancel/timeout state is per instance, so a restart interrupts running tasks.
- Per `PROJECT_STATUS.txt`, security hardening (e.g. input sanitization, GitHub token scoping) and test coverage are still in progress.

## License

MIT
