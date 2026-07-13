# ForgeAI

Autonomous AI coding agent platform. Submit a development task and a GitHub repo URL; ForgeAI orchestrates 6 specialized agents (Product Manager → Architect → Database → Backend → Frontend → DevOps) to produce a structured plan, generated code, and optionally a pull request — all visible in real time through a live pipeline dashboard.

## What works today

- **Live agent pipeline** — 6 agents run sequentially; the dashboard polls every 2s and shows each agent's status (pending / running / done / failed) as it changes
- **Real code generation** — Backend and Frontend agents return `{"files": [...]}` JSON with complete file contents; Database agent returns SQL migrations
- **Fire-and-forget execution** — `POST /api/tasks/:id/execute` returns 202 immediately; agents run in the background
- **Optional PR creation** — if `GITHUB_TOKEN` is set, creates a branch, commits all generated files, and opens a PR
- **No database required** — runs entirely in-memory by default; PostgreSQL is optional via `DATABASE_URL`

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, React, Tailwind CSS v3 |
| Backend | Express.js, TypeScript, Prisma (optional) |
| Agent core | Custom `AgentCoordinator` + 6 agent classes |
| LLM | Groq (`llama-3.3-70b-versatile`) via axios |
| Monorepo | npm workspaces (`backend/`, `frontend/`, `agent-core/`) |

## Setup

**Prerequisites**: Node.js 18+. No Docker or database needed for local development.

```bash
npm install
```

Create `backend/.env`:

```
GROQ_API_KEY=your_key_from_console.groq.com
# GITHUB_TOKEN=optional — enables branch + PR creation
# DATABASE_URL=optional — PostgreSQL; omit to use in-memory storage
```

Create `frontend/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

```bash
npm run dev   # builds agent-core, then starts backend :4000 + frontend :3000
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

## API

```
GET  /health                         System status and storage mode
GET  /api/tasks                      List all tasks
POST /api/tasks                      Create a task { prompt, repositoryUrl }
GET  /api/tasks/:id                  Get task with executions + logs
POST /api/tasks/:id/execute          Start execution (returns 202 immediately)
GET  /api/executions?taskId=:id      List agent execution records
GET  /api/pull-requests?taskId=:id   List PRs created for a task
```

## Project structure

```
Forge-AI/
├── agent-core/src/
│   ├── index.ts          AgentCoordinator — sequences agents, threads context
│   ├── agents/base.ts    6 agent classes with specialized system prompts
│   ├── llm/client.ts     Groq client (axios, retry/backoff on 429)
│   └── types.ts          Shared types: ExecutionContext, CodeChange, RepoContext
├── backend/src/
│   ├── index.ts          Express server + all API routes
│   ├── execution.ts      Task orchestration, real-time storage writes per agent
│   ├── storage.ts        Dual adapter: Prisma if DATABASE_URL set, else in-memory
│   └── github.ts         GitHub API: repo context fetch, branch, commit, PR
└── frontend/
    ├── pages/index.tsx        Dashboard: task form + live pipeline + recent tasks
    ├── components/
    │   ├── AgentPipeline.tsx  Live pipeline with animated rail + scan beam
    │   └── TaskForm.tsx       Command-panel style submission form
    └── lib/
        ├── api.ts             Axios client + typed API functions
        └── store.ts           Zustand store for task state
```

## Configuration

| Variable | Location | Required | Description |
|---|---|---|---|
| `