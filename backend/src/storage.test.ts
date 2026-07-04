import {
  MemoryStorage,
  AgentType,
  ExecutionStatus,
  LogLevel,
  TaskStatus,
} from './storage';

function makeStorage() {
  return new MemoryStorage();
}

const REPO_URL = 'https://github.com/owner/repo';
const PROMPT = 'Add rate limiting to the API';

describe('MemoryStorage', () => {
  // ── Task CRUD ─────────────────────────────────────────────────────────────

  describe('createTask', () => {
    it('creates a task with PENDING status and correct fields', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });

      expect(task.id).toHaveLength(36); // UUID
      expect(task.prompt).toBe(PROMPT);
      expect(task.repositoryUrl).toBe(REPO_URL);
      expect(task.repository).toBe('owner/repo');
      expect(task.status).toBe(TaskStatus.PENDING);
      expect(task.plan).toBeNull();
      expect(task.executions).toEqual([]);
      expect(task.logs).toEqual([]);
      expect(task.pullRequests).toEqual([]);
    });

    it('parses .git suffix out of repository slug', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({
        prompt: PROMPT,
        repositoryUrl: 'https://github.com/owner/repo.git',
      });
      expect(task.repository).toBe('owner/repo');
    });

    it('assigns a userId when one is provided', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL, userId: 'user-42' });
      expect(task.userId).toBe('user-42');
    });
  });

  describe('listTasks', () => {
    it('returns all created tasks', async () => {
      const storage = makeStorage();
      const a = await storage.createTask({ prompt: 'first', repositoryUrl: REPO_URL });
      const b = await storage.createTask({ prompt: 'second', repositoryUrl: REPO_URL });
      const tasks = await storage.listTasks();
      expect(tasks).toHaveLength(2);
      const ids = tasks.map((t) => t.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it('returns empty array when no tasks exist', async () => {
      const storage = makeStorage();
      expect(await storage.listTasks()).toEqual([]);
    });
  });

  describe('getTaskById', () => {
    it('returns null for unknown id', async () => {
      const storage = makeStorage();
      expect(await storage.getTaskById('nonexistent')).toBeNull();
    });

    it('returns the task with relations included', async () => {
      const storage = makeStorage();
      const { id } = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const task = await storage.getTaskById(id);
      expect(task).not.toBeNull();
      expect(task!.id).toBe(id);
      expect(Array.isArray(task!.executions)).toBe(true);
    });
  });

  describe('updateTask', () => {
    it('updates status and plan', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const updated = await storage.updateTask(task.id, {
        status: TaskStatus.COMPLETED,
        plan: 'Step 1: do thing',
      });
      expect(updated!.status).toBe(TaskStatus.COMPLETED);
      expect(updated!.plan).toBe('Step 1: do thing');
    });

    it('returns null for unknown id', async () => {
      const storage = makeStorage();
      expect(await storage.updateTask('missing', { status: TaskStatus.FAILED })).toBeNull();
    });

    it('preserves existing fields when only status is updated', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      await storage.updateTask(task.id, { plan: 'Plan A' });
      const updated = await storage.updateTask(task.id, { status: TaskStatus.IN_PROGRESS });
      expect(updated!.plan).toBe('Plan A');
    });
  });

  // ── Execution CRUD ────────────────────────────────────────────────────────

  describe('createExecution', () => {
    it('creates execution and attaches it to the task', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const exec = await storage.createExecution({
        taskId: task.id,
        agentType: AgentType.PRODUCT_MANAGER,
        status: ExecutionStatus.RUNNING,
      });

      expect(exec.taskId).toBe(task.id);
      expect(exec.agentType).toBe(AgentType.PRODUCT_MANAGER);
      expect(exec.status).toBe(ExecutionStatus.RUNNING);

      const fetched = await storage.getTaskById(task.id);
      expect(fetched!.executions).toHaveLength(1);
      expect(fetched!.executions[0].id).toBe(exec.id);
    });

    it('defaults status to PENDING when not provided', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const exec = await storage.createExecution({ taskId: task.id, agentType: AgentType.ARCHITECT });
      expect(exec.status).toBe(ExecutionStatus.PENDING);
    });
  });

  describe('updateExecution', () => {
    it('updates status and output', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const exec = await storage.createExecution({
        taskId: task.id,
        agentType: AgentType.BACKEND,
        status: ExecutionStatus.RUNNING,
      });

      const updated = await storage.updateExecution(exec.id, {
        status: ExecutionStatus.SUCCESS,
        output: '{"files":[]}',
      });

      expect(updated!.status).toBe(ExecutionStatus.SUCCESS);
      expect(updated!.output).toBe('{"files":[]}');
    });

    it('updates error on failure', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const exec = await storage.createExecution({
        taskId: task.id,
        agentType: AgentType.DEVOPS,
        status: ExecutionStatus.RUNNING,
      });
      const updated = await storage.updateExecution(exec.id, {
        status: ExecutionStatus.FAILED,
        error: 'Rate limit exceeded',
      });
      expect(updated!.status).toBe(ExecutionStatus.FAILED);
      expect(updated!.error).toBe('Rate limit exceeded');
    });

    it('returns null for unknown execution id', async () => {
      const storage = makeStorage();
      expect(await storage.updateExecution('ghost', { status: ExecutionStatus.SUCCESS })).toBeNull();
    });

    it('reflects update when task is refetched', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const exec = await storage.createExecution({
        taskId: task.id,
        agentType: AgentType.FRONTEND,
        status: ExecutionStatus.RUNNING,
      });
      await storage.updateExecution(exec.id, { status: ExecutionStatus.SUCCESS, output: 'done' });
      const fetched = await storage.getTaskById(task.id);
      expect(fetched!.executions[0].status).toBe(ExecutionStatus.SUCCESS);
      expect(fetched!.executions[0].output).toBe('done');
    });
  });

  describe('listExecutionsByTaskId', () => {
    it('returns executions in insertion order', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const types: AgentType[] = [AgentType.PRODUCT_MANAGER, AgentType.ARCHITECT, AgentType.DATABASE];
      for (const agentType of types) {
        await storage.createExecution({ taskId: task.id, agentType });
      }
      const execs = await storage.listExecutionsByTaskId(task.id);
      expect(execs.map((e) => e.agentType)).toEqual(types);
    });
  });

  // ── Logs ──────────────────────────────────────────────────────────────────

  describe('createExecutionLog', () => {
    it('creates a log and attaches it to the task', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const log = await storage.createExecutionLog({
        taskId: task.id,
        message: 'Agent started',
        level: LogLevel.INFO,
      });

      expect(log.message).toBe('Agent started');
      expect(log.level).toBe(LogLevel.INFO);
      expect(log.taskId).toBe(task.id);

      const fetched = await storage.getTaskById(task.id);
      expect(fetched!.logs).toHaveLength(1);
    });

    it('defaults level to INFO', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const log = await storage.createExecutionLog({ taskId: task.id, message: 'hello' });
      expect(log.level).toBe(LogLevel.INFO);
    });
  });

  // ── Pull Requests ─────────────────────────────────────────────────────────

  describe('createPullRequest', () => {
    it('creates a PR and attaches it to the task', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      const pr = await storage.createPullRequest({
        taskId: task.id,
        branchName: 'forgeai/add-rate-limiting',
        title: 'feat: add rate limiting',
        prUrl: 'https://github.com/owner/repo/pull/42',
      });

      expect(pr.taskId).toBe(task.id);
      expect(pr.branchName).toBe('forgeai/add-rate-limiting');
      expect(pr.prUrl).toBe('https://github.com/owner/repo/pull/42');

      const fetched = await storage.getTaskById(task.id);
      expect(fetched!.pullRequests).toHaveLength(1);
    });
  });

  describe('listPullRequestsByTaskId', () => {
    it('returns empty array when no PRs exist for a task', async () => {
      const storage = makeStorage();
      const task = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL });
      expect(await storage.listPullRequestsByTaskId(task.id)).toEqual([]);
    });
  });

  // ── Auth: per-user scoping + GitHub token ───────────────────────────────────

  describe('listTasks user scoping', () => {
    it('returns only the given user\'s tasks when userId is provided', async () => {
      const storage = makeStorage();
      const a = await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL, userId: 'user-a' });
      await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL, userId: 'user-b' });

      const forA = await storage.listTasks({ userId: 'user-a' });
      expect(forA).toHaveLength(1);
      expect(forA[0].id).toBe(a.id);
      expect(forA[0].userId).toBe('user-a');
    });

    it('returns all tasks when no userId filter is given (backwards compatible)', async () => {
      const storage = makeStorage();
      await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL, userId: 'user-a' });
      await storage.createTask({ prompt: PROMPT, repositoryUrl: REPO_URL, userId: 'user-b' });
      expect(await storage.listTasks()).toHaveLength(2);
    });
  });

  describe('user auth methods', () => {
    it('upserts a user by supabase id and returns a stable id', async () => {
      const storage = makeStorage();
      const id1 = await storage.upsertUserBySupabaseId({ supabaseUserId: 'sb-1', email: 'a@x.com', name: 'A' });
      const id2 = await storage.upsertUserBySupabaseId({ supabaseUserId: 'sb-1', email: 'a@x.com' });
      expect(id1).toBe(id2);
    });

    it('does NOT rebind a row already owned by another Supabase identity (no takeover)', async () => {
      const storage = makeStorage();
      const first = await storage.upsertUserBySupabaseId({ supabaseUserId: 'sb-1', email: 'shared@x.com' });
      // A different Supabase identity presenting the same email must not seize the
      // existing (already-bound) row — it gets its own distinct user instead.
      const second = await storage.upsertUserBySupabaseId({ supabaseUserId: 'sb-2', email: 'shared@x.com' });
      expect(second).not.toBe(first);
    });

    it('stores and reads back an opaque github token', async () => {
      const storage = makeStorage();
      const userId = await storage.upsertUserBySupabaseId({ supabaseUserId: 'sb-1', email: 'a@x.com' });
      expect(await storage.getEncryptedGithubToken(userId)).toBeNull();
      await storage.setUserGithubToken(userId, 'ENC(token)', 'octocat');
      expect(await storage.getEncryptedGithubToken(userId)).toBe('ENC(token)');
    });

    it('reports a profile with the hasGithubToken flag', async () => {
      const storage = makeStorage();
      const userId = await storage.upsertUserBySupabaseId({ supabaseUserId: 'sb-1', email: 'a@x.com', name: 'A' });
      expect(await storage.getUserProfile(userId)).toEqual({
        email: 'a@x.com',
        name: 'A',
        githubUsername: null,
        hasGithubToken: false,
      });
      await storage.setUserGithubToken(userId, 'ENC', 'octocat');
      const profile = await storage.getUserProfile(userId);
      expect(profile?.hasGithubToken).toBe(true);
      expect(profile?.githubUsername).toBe('octocat');
    });

    it('returns null profile for an unknown user', async () => {
      const storage = makeStorage();
      expect(await storage.getUserProfile('nope')).toBeNull();
    });
  });
});
