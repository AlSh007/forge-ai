import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { executeTask } from './execution';
import { storage } from './storage';
import { requestCancel, isRunning } from './taskControl';

// Load environment variables
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const isProduction = process.env.NODE_ENV === 'production';

// ─── CORS ──────────────────────────────────────────────────────────────────
// CORS_ORIGIN may be a single origin or a comma-separated list. In production an
// unset value is a misconfiguration (it would allow any origin), so we warn.
const corsOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (isProduction && corsOrigins.length === 0) {
  console.warn(
    '[cors] CORS_ORIGIN is not set in production — all origins will be allowed. ' +
      'Set it to your frontend URL(s) to lock this down.'
  );
}
app.use(cors(corsOrigins.length > 0 ? { origin: corsOrigins } : undefined));
app.use(express.json({ limit: '1mb' }));

// ─── Rate limiting ───────────────────────────────────────────────────────────
// Protects the API and, transitively, the shared Groq/GitHub quotas from abuse.
// In-memory store is fine for a single instance (the free-tier deployment).
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MIN ?? 60),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});
// Tighter limit on the expensive execution trigger (each run spends LLM tokens).
const executeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.EXECUTE_LIMIT_PER_MIN ?? 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many task executions — please slow down.' },
});
app.use('/api', apiLimiter);

const PROMPT_MAX_LENGTH = 2000;
const GITHUB_URL_RE = /^https?:\/\/github\.com\/[^/]+\/[^/]+(\.git)?$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidGitHubUrl(value: string): boolean {
  return GITHUB_URL_RE.test(value.trim());
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

// Health check endpoint
app.get(
  '/health',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      storage: await storage.getMode(),
    });
  })
);

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function parsePositiveInt(value: unknown, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  const floored = Math.floor(parsed);
  return max != null ? Math.min(floored, max) : floored;
}

app.get(
  '/api/tasks',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = parsePositiveInt(req.query.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const offset = parsePositiveInt(req.query.offset, 0);
    const tasks = await storage.listTasks({ limit, offset });
    res.json({ tasks, pagination: { limit, offset } });
  })
);

app.post(
  '/api/tasks',
  asyncHandler(async (req: Request, res: Response) => {
    const prompt = req.body.prompt;
    const repositoryUrl = req.body.repositoryUrl ?? req.body.repository;

    if (!isNonEmptyString(prompt) || !isNonEmptyString(repositoryUrl)) {
      res.status(400).json({ error: 'Both prompt and repositoryUrl are required.' });
      return;
    }

    if (prompt.trim().length > PROMPT_MAX_LENGTH) {
      res.status(400).json({ error: `prompt must be ${PROMPT_MAX_LENGTH} characters or fewer.` });
      return;
    }

    if (!isValidGitHubUrl(repositoryUrl)) {
      res.status(400).json({ error: 'repositoryUrl must be a valid GitHub repository URL (e.g. https://github.com/owner/repo).' });
      return;
    }

    const task = await storage.createTask({
      prompt: prompt.trim(),
      repositoryUrl: repositoryUrl.trim(),
    });

    await storage.createExecutionLog({
      taskId: task.id,
      message: 'Task created and queued for execution.',
    });

    const hydratedTask = await storage.getTaskById(task.id);

    res.status(201).json({
      task: hydratedTask ?? task,
    });
  })
);

app.get(
  '/api/tasks/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const task = await storage.getTaskById(req.params.id);

    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    res.json({ task });
  })
);

app.post(
  '/api/tasks/:id/execute',
  executeLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const task = await storage.getTaskById(req.params.id);

    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    const activeStatuses = ['PLANNING', 'IN_PROGRESS', 'VALIDATING'];
    if (activeStatuses.includes(task.status)) {
      res.status(409).json({ error: `Task is already executing (status: ${task.status}).` });
      return;
    }

    if (task.status === 'COMPLETED') {
      res.status(409).json({ error: 'Task has already completed. Create a new task to run again.' });
      return;
    }

    // Fire and forget — agents run in the background; client polls for progress
    void executeTask(req.params.id);

    res.status(202).json({ task });
  })
);

app.post(
  '/api/tasks/:id/cancel',
  asyncHandler(async (req: Request, res: Response) => {
    const task = await storage.getTaskById(req.params.id);

    if (!task) {
      res.status(404).json({ error: 'Task not found.' });
      return;
    }

    const activeStatuses = ['PLANNING', 'IN_PROGRESS', 'VALIDATING'];
    if (!activeStatuses.includes(task.status)) {
      res.status(409).json({ error: `Task is not running (status: ${task.status}).` });
      return;
    }

    // Cancellation is cooperative: the flag is picked up at the next agent-step
    // boundary, and the executor finalizes the task as CANCELLED. If the task
    // isn't running in this instance, it was orphaned by a restart — the startup
    // reconciler will have failed it, so treat that as "nothing to cancel here".
    const flagged = requestCancel(req.params.id);
    if (!flagged && !isRunning(req.params.id)) {
      res.status(409).json({
        error: 'Task is not running in this instance (it may have been interrupted by a restart).',
      });
      return;
    }

    await storage.createExecutionLog({
      taskId: task.id,
      message: 'Cancellation requested — the task will stop at the next step boundary.',
    });

    res.status(202).json({ task });
  })
);

app.get(
  '/api/executions',
  asyncHandler(async (req: Request, res: Response) => {
    const taskId = req.query.taskId;

    if (!isNonEmptyString(taskId)) {
      res.status(400).json({ error: 'taskId query parameter is required.' });
      return;
    }

    const executions = await storage.listExecutionsByTaskId(taskId);
    res.json({ executions });
  })
);

app.get(
  '/api/pull-requests',
  asyncHandler(async (req: Request, res: Response) => {
    const taskId = req.query.taskId;

    if (!isNonEmptyString(taskId)) {
      res.status(400).json({ error: 'taskId query parameter is required.' });
      return;
    }

    const pullRequests = await storage.listPullRequestsByTaskId(taskId);
    res.json({ pullRequests });
  })
);

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server after connecting storage and reconciling any tasks that were
// left mid-execution by a previous restart (deploy, crash, free-tier sleep).
async function start(): Promise<void> {
  await storage.connect();
  try {
    const reconciled = await storage.markInterruptedTasksFailed();
    if (reconciled > 0) {
      console.log(`[startup] Reconciled ${reconciled} interrupted task(s) → FAILED.`);
    }
  } catch (err) {
    console.error('[startup] Failed to reconcile interrupted tasks:', err);
  }

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  // A fail-loud storage error (e.g. missing DATABASE_URL in production) lands here.
  console.error('Fatal: server failed to start:', err);
  process.exit(1);
});
