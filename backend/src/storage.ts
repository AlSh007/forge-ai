import { randomUUID } from 'crypto';
import { PrismaClient, TaskStatus, AgentType, ExecutionStatus, LogLevel, PRStatus } from '@prisma/client';

export { TaskStatus, AgentType, ExecutionStatus, LogLevel, PRStatus };

const DEFAULT_USER_EMAIL = 'local@forgeai.dev';
const DEFAULT_USER_NAME = 'Local Demo User';

export interface PullRequestRecord {
  id: string;
  taskId: string;
  branchName: string;
  prUrl: string | null;
  status: PRStatus;
  title: string;
  description: string | null;
  changes: string | null;
  validationResults: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecutionRecord {
  id: string;
  taskId: string;
  agentType: AgentType;
  status: ExecutionStatus;
  input: string | null;
  output: string | null;
  logs: string | null;
  error: string | null;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionLogRecord {
  id: string;
  taskId: string | null;
  message: string;
  level: LogLevel;
  createdAt: string;
}

export interface TaskRecord {
  id: string;
  prompt: string;
  repository: string;
  repositoryUrl: string;
  userId: string;
  status: TaskStatus;
  plan: string | null;
  createdAt: string;
  updatedAt: string;
  executions: AgentExecutionRecord[];
  logs: ExecutionLogRecord[];
  pullRequests: PullRequestRecord[];
}

export interface CreateTaskInput {
  prompt: string;
  repositoryUrl: string;
  userId?: string;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  plan?: string | null;
}

export interface CreateExecutionInput {
  taskId: string;
  agentType: AgentType;
  status?: ExecutionStatus;
  input?: string | null;
  output?: string | null;
  logs?: string | null;
  error?: string | null;
  userId?: string;
}

export interface UpdateExecutionInput {
  status?: ExecutionStatus;
  output?: string | null;
  error?: string | null;
  logs?: string | null;
}

export interface CreateExecutionLogInput {
  taskId?: string | null;
  message: string;
  level?: LogLevel;
}

export interface CreatePullRequestInput {
  taskId: string;
  branchName: string;
  title: string;
  description?: string | null;
  prUrl?: string | null;
  changes?: string | null;
  validationResults?: string | null;
}

export interface ListTasksOptions {
  limit?: number;
  offset?: number;
  /** When set, only tasks owned by this user are returned. */
  userId?: string;
}

export interface UpsertUserInput {
  supabaseUserId: string;
  email: string;
  name?: string | null;
}

export interface UserProfile {
  email: string;
  name: string | null;
  githubUsername: string | null;
  hasGithubToken: boolean;
}

// Statuses that mean a task was mid-execution. If the process died (deploy,
// crash, free-tier sleep) while a task was in one of these, it is orphaned —
// nothing will ever move it forward. The reconciler fails these on boot.
export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.PLANNING,
  TaskStatus.IN_PROGRESS,
  TaskStatus.VALIDATING,
];

interface StorageAdapter {
  connect(): Promise<void>;
  listTasks(options?: ListTasksOptions): Promise<TaskRecord[]>;
  getTaskById(id: string): Promise<TaskRecord | null>;
  markInterruptedTasksFailed(): Promise<number>;
  // Auth: map a Supabase identity to a local User (returns the local userId),
  // and manage that user's encrypted GitHub token. The token is stored/returned
  // as an opaque encrypted string — callers encrypt/decrypt (see crypto.ts).
  upsertUserBySupabaseId(input: UpsertUserInput): Promise<string>;
  setUserGithubToken(userId: string, encryptedToken: string, githubUsername?: string | null): Promise<void>;
  getEncryptedGithubToken(userId: string): Promise<string | null>;
  getUserProfile(userId: string): Promise<UserProfile | null>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  updateTask(id: string, input: UpdateTaskInput): Promise<TaskRecord | null>;
  createExecution(input: CreateExecutionInput): Promise<AgentExecutionRecord>;
  updateExecution(id: string, input: UpdateExecutionInput): Promise<AgentExecutionRecord | null>;
  listExecutionsByTaskId(taskId: string): Promise<AgentExecutionRecord[]>;
  createExecutionLog(input: CreateExecutionLogInput): Promise<ExecutionLogRecord>;
  listPullRequestsByTaskId(taskId: string): Promise<PullRequestRecord[]>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseRepositoryUrl(repositoryUrl: string): { owner: string; name: string; slug: string } {
  try {
    const normalizedUrl = repositoryUrl.endsWith('.git')
      ? repositoryUrl.slice(0, -4)
      : repositoryUrl;
    const parsedUrl = new URL(normalizedUrl);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const owner = segments[0] ?? 'unknown';
    const name = segments[1] ?? owner;
    const slug = segments.slice(0, 2).join('/') || normalizedUrl;

    return { owner, name, slug };
  } catch {
    return {
      owner: 'unknown',
      name: repositoryUrl,
      slug: repositoryUrl,
    };
  }
}

function toExecutionRecord(execution: {
  id: string;
  taskId: string;
  agentType: AgentType;
  status: ExecutionStatus;
  input: string | null;
  output: string | null;
  logs: string | null;
  error: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}): AgentExecutionRecord {
  return {
    id: execution.id,
    taskId: execution.taskId,
    agentType: execution.agentType,
    status: execution.status,
    input: execution.input,
    output: execution.output,
    logs: execution.logs,
    error: execution.error,
    userId: execution.userId,
    createdAt: execution.createdAt.toISOString(),
    updatedAt: execution.updatedAt.toISOString(),
  };
}

function toLogRecord(log: {
  id: string;
  taskId: string | null;
  message: string;
  level: LogLevel;
  createdAt: Date;
}): ExecutionLogRecord {
  return {
    id: log.id,
    taskId: log.taskId,
    message: log.message,
    level: log.level,
    createdAt: log.createdAt.toISOString(),
  };
}

function toPullRequestRecord(pullRequest: {
  id: string;
  taskId: string;
  branchName: string;
  prUrl: string | null;
  status: PRStatus;
  title: string;
  description: string | null;
  changes: string | null;
  validationResults: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PullRequestRecord {
  return {
    id: pullRequest.id,
    taskId: pullRequest.taskId,
    branchName: pullRequest.branchName,
    prUrl: pullRequest.prUrl,
    status: pullRequest.status,
    title: pullRequest.title,
    description: pullRequest.description,
    changes: pullRequest.changes,
    validationResults: pullRequest.validationResults,
    createdAt: pullRequest.createdAt.toISOString(),
    updatedAt: pullRequest.updatedAt.toISOString(),
  };
}

function toTaskRecord(
  task: {
    id: string;
    prompt: string;
    repository: string;
    repositoryUrl: string;
    userId: string;
    status: TaskStatus;
    plan: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  executions: AgentExecutionRecord[] = [],
  logs: ExecutionLogRecord[] = [],
  pullRequests: PullRequestRecord[] = []
): TaskRecord {
  return {
    id: task.id,
    prompt: task.prompt,
    repository: task.repository,
    repositoryUrl: task.repositoryUrl,
    userId: task.userId,
    status: task.status,
    plan: task.plan,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    executions,
    logs,
    pullRequests,
  };
}

interface MemoryUser {
  id: string;
  email: string;
  name: string | null;
  supabaseUserId?: string;
  githubUsername: string | null;
  githubAccessToken: string | null;
}

export class MemoryStorage implements StorageAdapter {
  private tasks = new Map<string, TaskRecord>();
  private executions = new Map<string, AgentExecutionRecord[]>();
  private logs = new Map<string, ExecutionLogRecord[]>();
  private pullRequests = new Map<string, PullRequestRecord[]>();
  private users = new Map<string, MemoryUser>();
  private readonly defaultUserId = 'local-user';

  async connect(): Promise<void> {
    return Promise.resolve();
  }

  async listTasks(options?: ListTasksOptions): Promise<TaskRecord[]> {
    let all = Array.from(this.tasks.values());
    if (options?.userId != null) {
      all = all.filter((task) => task.userId === options.userId);
    }
    const sorted = all.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = options?.offset ?? 0;
    const windowed =
      options?.limit != null ? sorted.slice(offset, offset + options.limit) : sorted.slice(offset);
    return windowed.map((task) => this.withRelations(task));
  }

  async upsertUserBySupabaseId(input: UpsertUserInput): Promise<string> {
    // Exact Supabase-identity match — same person, safe to update.
    for (const user of this.users.values()) {
      if (user.supabaseUserId === input.supabaseUserId) {
        user.email = input.email;
        user.name = input.name ?? user.name;
        return user.id;
      }
    }
    // Adopt an UNBOUND legacy row with the same email; never rebind a row already
    // tied to a different Supabase identity (see PrismaStorage note — takeover).
    for (const user of this.users.values()) {
      if (user.email === input.email && user.supabaseUserId == null) {
        user.supabaseUserId = input.supabaseUserId;
        user.name = input.name ?? user.name;
        return user.id;
      }
    }
    const id = randomUUID();
    this.users.set(id, {
      id,
      email: input.email,
      name: input.name ?? null,
      supabaseUserId: input.supabaseUserId,
      githubUsername: null,
      githubAccessToken: null,
    });
    return id;
  }

  async setUserGithubToken(
    userId: string,
    encryptedToken: string,
    githubUsername?: string | null
  ): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    user.githubAccessToken = encryptedToken;
    if (githubUsername !== undefined) user.githubUsername = githubUsername;
  }

  async getEncryptedGithubToken(userId: string): Promise<string | null> {
    return this.users.get(userId)?.githubAccessToken ?? null;
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const user = this.users.get(userId);
    if (!user) return null;
    return {
      email: user.email,
      name: user.name,
      githubUsername: user.githubUsername,
      hasGithubToken: !!user.githubAccessToken,
    };
  }

  async getTaskById(id: string): Promise<TaskRecord | null> {
    const task = this.tasks.get(id);
    return task ? this.withRelations(task) : null;
  }

  async markInterruptedTasksFailed(): Promise<number> {
    // In-memory storage starts empty on every boot, so there is nothing to
    // reconcile — but keep the behavior consistent with the Prisma adapter.
    let count = 0;
    for (const [id, task] of this.tasks.entries()) {
      if (ACTIVE_TASK_STATUSES.includes(task.status)) {
        this.tasks.set(id, { ...task, status: TaskStatus.FAILED, updatedAt: nowIso() });
        await this.createExecutionLog({
          taskId: id,
          message: 'Task was interrupted (server restarted mid-execution) and has been marked FAILED.',
          level: LogLevel.ERROR,
        });
        count++;
      }
    }
    return count;
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const timestamp = nowIso();
    const repository = parseRepositoryUrl(input.repositoryUrl);
    const task: TaskRecord = {
      id: randomUUID(),
      prompt: input.prompt,
      repository: repository.slug,
      repositoryUrl: input.repositoryUrl,
      userId: input.userId ?? this.defaultUserId,
      status: TaskStatus.PENDING,
      plan: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      executions: [],
      logs: [],
      pullRequests: [],
    };

    this.tasks.set(task.id, task);
    this.executions.set(task.id, []);
    this.logs.set(task.id, []);
    this.pullRequests.set(task.id, []);

    return this.withRelations(task);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<TaskRecord | null> {
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }

    const updatedTask: TaskRecord = {
      ...task,
      status: input.status ?? task.status,
      plan: input.plan === undefined ? task.plan : input.plan,
      updatedAt: nowIso(),
    };

    this.tasks.set(id, updatedTask);

    return this.withRelations(updatedTask);
  }

  async createExecution(input: CreateExecutionInput): Promise<AgentExecutionRecord> {
    const timestamp = nowIso();
    const execution: AgentExecutionRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      agentType: input.agentType,
      status: input.status ?? ExecutionStatus.PENDING,
      input: input.input ?? null,
      output: input.output ?? null,
      logs: input.logs ?? null,
      error: input.error ?? null,
      userId: input.userId ?? this.defaultUserId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const taskExecutions = this.executions.get(input.taskId) ?? [];
    taskExecutions.push(execution);
    this.executions.set(input.taskId, taskExecutions);
    await this.touchTask(input.taskId);

    return execution;
  }

  async updateExecution(id: string, input: UpdateExecutionInput): Promise<AgentExecutionRecord | null> {
    for (const [taskId, executions] of this.executions.entries()) {
      const idx = executions.findIndex((e) => e.id === id);
      if (idx !== -1) {
        const updated: AgentExecutionRecord = {
          ...executions[idx],
          status: input.status ?? executions[idx].status,
          output: input.output === undefined ? executions[idx].output : input.output,
          error: input.error === undefined ? executions[idx].error : input.error,
          logs: input.logs === undefined ? executions[idx].logs : input.logs,
          updatedAt: nowIso(),
        };
        executions[idx] = updated;
        this.executions.set(taskId, executions);
        await this.touchTask(taskId);
        return updated;
      }
    }
    return null;
  }

  async listExecutionsByTaskId(taskId: string): Promise<AgentExecutionRecord[]> {
    return [...(this.executions.get(taskId) ?? [])];
  }

  async createExecutionLog(input: CreateExecutionLogInput): Promise<ExecutionLogRecord> {
    const log: ExecutionLogRecord = {
      id: randomUUID(),
      taskId: input.taskId ?? null,
      message: input.message,
      level: input.level ?? LogLevel.INFO,
      createdAt: nowIso(),
    };

    if (input.taskId) {
      const taskLogs = this.logs.get(input.taskId) ?? [];
      taskLogs.push(log);
      this.logs.set(input.taskId, taskLogs);
      await this.touchTask(input.taskId);
    }

    return log;
  }

  async listPullRequestsByTaskId(taskId: string): Promise<PullRequestRecord[]> {
    return [...(this.pullRequests.get(taskId) ?? [])];
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    const timestamp = nowIso();
    const pr: PullRequestRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      branchName: input.branchName,
      title: input.title,
      description: input.description ?? null,
      prUrl: input.prUrl ?? null,
      changes: input.changes ?? null,
      validationResults: input.validationResults ?? null,
      status: PRStatus.READY,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const taskPRs = this.pullRequests.get(input.taskId) ?? [];
    taskPRs.push(pr);
    this.pullRequests.set(input.taskId, taskPRs);
    await this.touchTask(input.taskId);
    return pr;
  }

  private withRelations(task: TaskRecord): TaskRecord {
    return {
      ...task,
      executions: [...(this.executions.get(task.id) ?? [])],
      logs: [...(this.logs.get(task.id) ?? [])],
      pullRequests: [...(this.pullRequests.get(task.id) ?? [])],
    };
  }

  private async touchTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return;
    }

    this.tasks.set(taskId, {
      ...task,
      updatedAt: nowIso(),
    });
  }
}

class PrismaStorage implements StorageAdapter {
  private defaultUserId?: string;

  constructor(private readonly prisma: PrismaClient) {}

  async connect(): Promise<void> {
    await this.prisma.$connect();
  }

  async listTasks(options?: ListTasksOptions): Promise<TaskRecord[]> {
    const tasks = await this.prisma.task.findMany({
      ...(options?.userId != null && { where: { userId: options.userId } }),
      orderBy: {
        createdAt: 'desc',
      },
      ...(options?.limit != null && { take: options.limit }),
      ...(options?.offset != null && { skip: options.offset }),
    });

    return tasks.map((task: any) => toTaskRecord(task));
  }

  async upsertUserBySupabaseId(input: UpsertUserInput): Promise<string> {
    // Prefer matching on the Supabase identity; fall back to linking a pre-existing
    // row with the same email (avoids a unique-email violation), else create.
    const bySupabase = await this.prisma.user.findUnique({
      where: { supabaseUserId: input.supabaseUserId },
      select: { id: true },
    });
    if (bySupabase) {
      await this.prisma.user.update({
        where: { id: bySupabase.id },
        data: { email: input.email, name: input.name ?? undefined },
      });
      return bySupabase.id;
    }

    const byEmail = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, supabaseUserId: true },
    });
    // Adopt a pre-existing row ONLY if it has no Supabase identity yet (a legacy/
    // local row). Never rebind a row already owned by a *different* Supabase
    // identity — doing so would be an account-takeover primitive (an attacker with
    // a matching email claim could seize the victim's tasks and stored GitHub token).
    if (byEmail && byEmail.supabaseUserId == null) {
      await this.prisma.user.update({
        where: { id: byEmail.id },
        data: { supabaseUserId: input.supabaseUserId, name: input.name ?? undefined },
      });
      return byEmail.id;
    }

    const created = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name ?? null,
        supabaseUserId: input.supabaseUserId,
      },
      select: { id: true },
    });
    return created.id;
  }

  async setUserGithubToken(
    userId: string,
    encryptedToken: string,
    githubUsername?: string | null
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        githubAccessToken: encryptedToken,
        githubTokenUpdatedAt: new Date(),
        ...(githubUsername !== undefined && { githubUsername }),
      },
    });
  }

  async getEncryptedGithubToken(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { githubAccessToken: true },
    });
    return user?.githubAccessToken ?? null;
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, githubUsername: true, githubAccessToken: true },
    });
    if (!user) return null;
    return {
      email: user.email,
      name: user.name,
      githubUsername: user.githubUsername,
      hasGithubToken: !!user.githubAccessToken,
    };
  }

  async markInterruptedTasksFailed(): Promise<number> {
    const orphaned = await this.prisma.task.findMany({
      where: { status: { in: ACTIVE_TASK_STATUSES } },
      select: { id: true },
    });
    if (orphaned.length === 0) return 0;

    await this.prisma.task.updateMany({
      where: { status: { in: ACTIVE_TASK_STATUSES } },
      data: { status: TaskStatus.FAILED },
    });

    await this.prisma.executionLog.createMany({
      data: orphaned.map((t: { id: string }) => ({
        taskId: t.id,
        message: 'Task was interrupted (server restarted mid-execution) and has been marked FAILED.',
        level: LogLevel.ERROR,
      })),
    });

    return orphaned.length;
  }

  async getTaskById(id: string): Promise<TaskRecord | null> {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: {
        executions: {
          orderBy: {
            createdAt: 'asc',
          },
        },
        pullRequests: true,
      },
    });

    if (!task) {
      return null;
    }

    const logs = await this.prisma.executionLog.findMany({
      where: { taskId: id },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return toTaskRecord(
      task,
      task.executions.map(toExecutionRecord),
      logs.map(toLogRecord),
      task.pullRequests.map(toPullRequestRecord)
    );
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const userId = input.userId ?? await this.ensureDefaultUserId();
    const repository = parseRepositoryUrl(input.repositoryUrl);

    await this.prisma.repository.upsert({
      where: {
        url: input.repositoryUrl,
      },
      update: {
        owner: repository.owner,
        name: repository.name,
      },
      create: {
        url: input.repositoryUrl,
        owner: repository.owner,
        name: repository.name,
      },
    });

    const task = await this.prisma.task.create({
      data: {
        prompt: input.prompt,
        repository: repository.slug,
        repositoryUrl: input.repositoryUrl,
        userId,
        status: TaskStatus.PENDING,
      },
    });

    return toTaskRecord(task);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<TaskRecord | null> {
    try {
      const task = await this.prisma.task.update({
        where: { id },
        data: {
          status: input.status,
          plan: input.plan,
        },
      });

      return toTaskRecord(task);
    } catch {
      return null;
    }
  }

  async createExecution(input: CreateExecutionInput): Promise<AgentExecutionRecord> {
    const userId = input.userId ?? await this.ensureDefaultUserId();
    const execution = await this.prisma.agentExecution.create({
      data: {
        taskId: input.taskId,
        agentType: input.agentType,
        status: input.status ?? ExecutionStatus.PENDING,
        input: input.input ?? null,
        output: input.output ?? null,
        logs: input.logs ?? null,
        error: input.error ?? null,
        userId,
      },
    });

    return toExecutionRecord(execution);
  }

  async updateExecution(id: string, input: UpdateExecutionInput): Promise<AgentExecutionRecord | null> {
    try {
      const execution = await this.prisma.agentExecution.update({
        where: { id },
        data: {
          ...(input.status !== undefined && { status: input.status }),
          ...(input.output !== undefined && { output: input.output }),
          ...(input.error !== undefined && { error: input.error }),
          ...(input.logs !== undefined && { logs: input.logs }),
        },
      });
      return toExecutionRecord(execution);
    } catch {
      return null;
    }
  }

  async listExecutionsByTaskId(taskId: string): Promise<AgentExecutionRecord[]> {
    const executions = await this.prisma.agentExecution.findMany({
      where: { taskId },
      orderBy: {
        createdAt: 'asc',
      },
    });

    return executions.map(toExecutionRecord);
  }

  async createExecutionLog(input: CreateExecutionLogInput): Promise<ExecutionLogRecord> {
    const log = await this.prisma.executionLog.create({
      data: {
        taskId: input.taskId ?? null,
        message: input.message,
        level: input.level ?? LogLevel.INFO,
      },
    });

    return toLogRecord(log);
  }

  async listPullRequestsByTaskId(taskId: string): Promise<PullRequestRecord[]> {
    const pullRequests = await this.prisma.pullRequest.findMany({
      where: { taskId },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return pullRequests.map(toPullRequestRecord);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    const pr = await this.prisma.pullRequest.create({
      data: {
        taskId: input.taskId,
        branchName: input.branchName,
        title: input.title,
        description: input.description ?? null,
        prUrl: input.prUrl ?? null,
        changes: input.changes ?? null,
        validationResults: input.validationResults ?? null,
        status: PRStatus.READY,
      },
    });
    return toPullRequestRecord(pr);
  }

  private async ensureDefaultUserId(): Promise<string> {
    if (this.defaultUserId) {
      return this.defaultUserId;
    }

    const user = await this.prisma.user.upsert({
      where: {
        email: DEFAULT_USER_EMAIL,
      },
      update: {
        name: DEFAULT_USER_NAME,
      },
      create: {
        email: DEFAULT_USER_EMAIL,
        name: DEFAULT_USER_NAME,
      },
    });

    this.defaultUserId = user.id;
    return user.id;
  }
}

type StorageMode = 'memory' | 'prisma';

class ForgeStorage implements StorageAdapter {
  private readonly memoryStorage = new MemoryStorage();
  private prismaStorage?: PrismaStorage;
  private adapter?: StorageAdapter;
  private mode?: StorageMode;
  private resolved = false;

  async connect(): Promise<void> {
    await this.getAdapter();
  }

  async listTasks(options?: ListTasksOptions): Promise<TaskRecord[]> {
    return (await this.getAdapter()).listTasks(options);
  }

  async getTaskById(id: string): Promise<TaskRecord | null> {
    return (await this.getAdapter()).getTaskById(id);
  }

  async markInterruptedTasksFailed(): Promise<number> {
    return (await this.getAdapter()).markInterruptedTasksFailed();
  }

  async upsertUserBySupabaseId(input: UpsertUserInput): Promise<string> {
    return (await this.getAdapter()).upsertUserBySupabaseId(input);
  }

  async setUserGithubToken(
    userId: string,
    encryptedToken: string,
    githubUsername?: string | null
  ): Promise<void> {
    return (await this.getAdapter()).setUserGithubToken(userId, encryptedToken, githubUsername);
  }

  async getEncryptedGithubToken(userId: string): Promise<string | null> {
    return (await this.getAdapter()).getEncryptedGithubToken(userId);
  }

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    return (await this.getAdapter()).getUserProfile(userId);
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    return (await this.getAdapter()).createTask(input);
  }

  async updateTask(id: string, input: UpdateTaskInput): Promise<TaskRecord | null> {
    return (await this.getAdapter()).updateTask(id, input);
  }

  async createExecution(input: CreateExecutionInput): Promise<AgentExecutionRecord> {
    return (await this.getAdapter()).createExecution(input);
  }

  async updateExecution(id: string, input: UpdateExecutionInput): Promise<AgentExecutionRecord | null> {
    return (await this.getAdapter()).updateExecution(id, input);
  }

  async listExecutionsByTaskId(taskId: string): Promise<AgentExecutionRecord[]> {
    return (await this.getAdapter()).listExecutionsByTaskId(taskId);
  }

  async createExecutionLog(input: CreateExecutionLogInput): Promise<ExecutionLogRecord> {
    return (await this.getAdapter()).createExecutionLog(input);
  }

  async listPullRequestsByTaskId(taskId: string): Promise<PullRequestRecord[]> {
    return (await this.getAdapter()).listPullRequestsByTaskId(taskId);
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRecord> {
    return (await this.getAdapter()).createPullRequest(input);
  }

  async getMode(): Promise<StorageMode> {
    await this.getAdapter();
    return this.mode ?? 'memory';
  }

  private async getAdapter(): Promise<StorageAdapter> {
    if (this.adapter) {
      return this.adapter;
    }

    if (this.resolved) {
      return this.memoryStorage;
    }

    this.resolved = true;
    const isProduction = process.env.NODE_ENV === 'production';

    if (!process.env.DATABASE_URL) {
      // In production the in-memory store is never acceptable — data would vanish
      // on every restart and silently diverge across instances. Fail loudly so the
      // misconfiguration is caught at boot instead of after data loss.
      if (isProduction) {
        throw new Error(
          'DATABASE_URL is not set in production. Refusing to start with the in-memory store ' +
            '(data would be lost on every restart). Set DATABASE_URL or explicitly run in development.'
        );
      }
      this.adapter = this.memoryStorage;
      this.mode = 'memory';
      return this.adapter;
    }

    try {
      this.prismaStorage = new PrismaStorage(new PrismaClient());
      await this.prismaStorage.connect();
      this.adapter = this.prismaStorage;
      this.mode = 'prisma';
    } catch (error) {
      // A DB was configured but is unreachable. In production, do NOT degrade to
      // in-memory — that hides an outage and loses writes. Crash so the platform
      // restarts us and the failure is visible.
      if (isProduction) {
        throw new Error(
          `DATABASE_URL is set but the database is unreachable: ${
            error instanceof Error ? error.message : 'Unknown error'
          }. Refusing to fall back to in-memory storage in production.`
        );
      }
      console.warn(
        'Database unavailable, falling back to in-memory storage:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      this.adapter = this.memoryStorage;
      this.mode = 'memory';
    }

    return this.adapter;
  }
}

export const storage = new ForgeStorage();
