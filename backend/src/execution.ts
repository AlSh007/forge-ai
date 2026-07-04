import {
  AgentCoordinator,
  AgentType as CoordinatorAgentType,
  ExecutionContext,
  formatStaticResults,
  ProgressCallback,
  RepoAccess,
  RepoContext,
  TaskExecutionResult,
} from 'forgeai-agent-core';
import { AgentType, ExecutionStatus, LogLevel, TaskStatus, storage, TaskRecord } from './storage';
import { createGitHubService, GitHubService } from './github';
import { registerTask, unregisterTask, requestCancel, isCancelled } from './taskControl';
import { decryptSecret } from './crypto';

const coordinator = new AgentCoordinator();

/**
 * Builds a GitHub client for the task owner. Prefers the user's own encrypted
 * OAuth token (so PRs are attributed to them); falls back to the shared
 * GITHUB_TOKEN env var for local/dev; returns null if neither is available (PR
 * creation is then skipped, same as before).
 */
async function createGitHubServiceForUser(userId: string): Promise<GitHubService | null> {
  const encrypted = await storage.getEncryptedGithubToken(userId);
  if (encrypted) {
    try {
      return new GitHubService(decryptSecret(encrypted));
    } catch (err) {
      console.error('[execution] Failed to decrypt user GitHub token; falling back to env token.', err);
    }
  }
  return createGitHubService();
}

// Hard ceiling on a single task run. On the free tier a hung LLM call could
// otherwise keep a task "running" until the instance is recycled. When exceeded,
// cancellation is requested and the run stops at the next agent-step boundary.
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 10 * 60 * 1000);

const agentTypeMap: Record<CoordinatorAgentType, AgentType> = {
  [CoordinatorAgentType.PRODUCT_MANAGER]: AgentType.PRODUCT_MANAGER,
  [CoordinatorAgentType.ARCHITECT]: AgentType.ARCHITECT,
  [CoordinatorAgentType.BACKEND]: AgentType.BACKEND,
  [CoordinatorAgentType.FRONTEND]: AgentType.FRONTEND,
  [CoordinatorAgentType.DATABASE]: AgentType.DATABASE,
  [CoordinatorAgentType.DEVOPS]: AgentType.DEVOPS,
};

/**
 * GitHub-backed repo access for agent tools. Serves files already in the fetched
 * snapshot and lists/searches over the cached file tree to avoid extra API calls;
 * only an uncached read_file hits the network.
 */
function createRepoAccess(
  github: GitHubService,
  repositoryUrl: string,
  repoContext?: RepoContext
): RepoAccess {
  const cachedPaths = repoContext?.structure
    ? repoContext.structure.split('\n').map((p) => p.trim()).filter(Boolean)
    : [];

  return {
    async readFile(path: string): Promise<string | null> {
      const cached = repoContext?.keyFiles?.[path];
      if (cached != null) return cached;
      return github.readFile(repositoryUrl, path);
    },
    async listFiles(): Promise<string[]> {
      return cachedPaths.length > 0 ? cachedPaths : github.listFiles(repositoryUrl);
    },
    async searchFiles(query: string): Promise<string[]> {
      const paths = cachedPaths.length > 0 ? cachedPaths : await github.listFiles(repositoryUrl);
      const needle = query.toLowerCase();
      return paths.filter((p) => p.toLowerCase().includes(needle));
    },
  };
}

function createExecutionContext(
  task: TaskRecord,
  repoContext?: RepoContext,
  repoAccess?: RepoAccess
): ExecutionContext {
  return {
    taskId: task.id,
    repository: task.repositoryUrl,
    branch: `forge/${task.id}`,
    userId: task.userId,
    environment: {
      nodeVersion: process.version,
      framework: repoContext?.framework,
    },
    repoContext,
    repoAccess,
  };
}

function makeProgressCallback(task: TaskRecord): {
  callback: ProgressCallback;
  getExecutionId: (agentName: string) => string | undefined;
} {
  const executionIds = new Map<string, string>();

  const callback: ProgressCallback = async (event) => {
    if (event.status === 'started') {
      const exec = await storage.createExecution({
        taskId: task.id,
        userId: task.userId,
        agentType: agentTypeMap[event.agentType],
        status: ExecutionStatus.RUNNING,
        input: event.input ?? null,
      });
      executionIds.set(event.agentName, exec.id);
      await storage.createExecutionLog({
        taskId: task.id,
        message: `${event.agentName} started.`,
        level: LogLevel.INFO,
      });
    } else {
      const execId = executionIds.get(event.agentName);
      if (execId) {
        await storage.updateExecution(execId, {
          status: event.status === 'completed' ? ExecutionStatus.SUCCESS : ExecutionStatus.FAILED,
          output: event.output ?? null,
          error: event.error ?? null,
          logs: event.status === 'completed'
            ? `${event.agentName} completed successfully.`
            : `${event.agentName} failed: ${event.error ?? 'Unknown error'}`,
        });
      }
      await storage.createExecutionLog({
        taskId: task.id,
        message: event.status === 'completed'
          ? `${event.agentName} completed successfully.`
          : `${event.agentName} failed: ${event.error ?? 'Unknown error'}`,
        level: event.status === 'completed' ? LogLevel.INFO : LogLevel.ERROR,
      });
    }
  };

  return { callback, getExecutionId: (name) => executionIds.get(name) };
}

async function finalizeTask(task: TaskRecord, result: TaskExecutionResult): Promise<TaskRecord | null> {
  const nextStatus = result.cancelled
    ? TaskStatus.CANCELLED
    : result.success
      ? TaskStatus.COMPLETED
      : TaskStatus.FAILED;
  await storage.updateTask(task.id, {
    status: nextStatus,
    plan: result.plan ?? task.plan,
  });
  await storage.createExecutionLog({
    taskId: task.id,
    message: result.cancelled
      ? 'Task was cancelled before completion.'
      : result.success
        ? 'Task completed successfully.'
        : `Task failed: ${result.error ?? 'Unknown error'}`,
    level: result.cancelled ? LogLevel.WARN : result.success ? LogLevel.INFO : LogLevel.ERROR,
  });
  return storage.getTaskById(task.id);
}

async function createPRFromResult(task: TaskRecord, result: TaskExecutionResult): Promise<void> {
  const github = await createGitHubServiceForUser(task.userId);
  if (!github) {
    await storage.createExecutionLog({
      taskId: task.id,
      message: 'GITHUB_TOKEN not set — skipping PR creation.',
      level: LogLevel.WARN,
    });
    return;
  }

  const codeChanges = result.codeChanges ?? [];
  if (codeChanges.length === 0) {
    await storage.createExecutionLog({
      taskId: task.id,
      message: 'No file changes generated — skipping PR creation.',
      level: LogLevel.INFO,
    });
    return;
  }

  const branchName = `forge/${task.id}`;
  const title = task.prompt.slice(0, 72);
  const prBody = [
    '## Summary',
    result.plan ?? task.prompt,
    '',
    '## Validation',
    result.validation ?? 'N/A',
    '',
    `---`,
    `*Generated by ForgeAI — task \`${task.id}\`*`,
  ].join('\n');

  try {
    await github.createBranch(task.repositoryUrl, branchName);
    await storage.createExecutionLog({
      taskId: task.id,
      message: `Branch \`${branchName}\` created.`,
      level: LogLevel.INFO,
    });

    await github.commitFiles(task.repositoryUrl, branchName, codeChanges, `forge: ${title}`);
    await storage.createExecutionLog({
      taskId: task.id,
      message: `Committed ${codeChanges.length} file(s) to \`${branchName}\`.`,
      level: LogLevel.INFO,
    });

    const pr = await github.createPullRequest(task.repositoryUrl, branchName, title, prBody);

    await storage.createPullRequest({
      taskId: task.id,
      branchName,
      title,
      prUrl: pr.url,
      description: result.plan ?? null,
      validationResults: result.validation ?? null,
      changes: codeChanges.map((f) => f.path).join('\n'),
    });

    await storage.createExecutionLog({
      taskId: task.id,
      message: `Pull request created: ${pr.url}`,
      level: LogLevel.INFO,
    });
  } catch (err) {
    await storage.createExecutionLog({
      taskId: task.id,
      message: `PR creation failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      level: LogLevel.ERROR,
    });
  }
}

export async function executeTask(taskId: string): Promise<TaskRecord | null> {
  const task = await storage.getTaskById(taskId);
  if (!task) return null;

  registerTask(task.id);
  const timeout = setTimeout(() => {
    requestCancel(task.id);
    void storage.createExecutionLog({
      taskId: task.id,
      message: `Task exceeded the ${Math.round(TASK_TIMEOUT_MS / 1000)}s time limit — cancelling.`,
      level: LogLevel.WARN,
    });
  }, TASK_TIMEOUT_MS);

  try {
    return await runExecution(task);
  } finally {
    clearTimeout(timeout);
    unregisterTask(task.id);
  }
}

async function runExecution(task: TaskRecord): Promise<TaskRecord | null> {
  await storage.updateTask(task.id, { status: TaskStatus.PLANNING });
  await storage.createExecutionLog({
    taskId: task.id,
    message: 'Task execution started.',
    level: LogLevel.INFO,
  });

  let repoContext: RepoContext | undefined;
  const github = await createGitHubServiceForUser(task.userId);
  if (github) {
    try {
      await storage.createExecutionLog({
        taskId: task.id,
        message: `Fetching repository context for ${task.repositoryUrl}…`,
        level: LogLevel.INFO,
      });
      repoContext = await github.fetchRepoContext(task.repositoryUrl);
      await storage.createExecutionLog({
        taskId: task.id,
        message: `Repository context loaded (${Object.keys(repoContext.keyFiles).length} key files).`,
        level: LogLevel.INFO,
      });
    } catch (err) {
      await storage.createExecutionLog({
        taskId: task.id,
        message: `Could not fetch repo context: ${err instanceof Error ? err.message : 'unknown'}. Proceeding without it.`,
        level: LogLevel.WARN,
      });
    }
  }

  await storage.updateTask(task.id, { status: TaskStatus.IN_PROGRESS });

  const repoAccess = github ? createRepoAccess(github, task.repositoryUrl, repoContext) : undefined;
  if (repoAccess) {
    await storage.createExecutionLog({
      taskId: task.id,
      message: 'Repo tools enabled — agents can read files on demand.',
      level: LogLevel.INFO,
    });
  }

  const executionContext = createExecutionContext(task, repoContext, repoAccess);
  const { callback: onProgress } = makeProgressCallback(task);

  const result = await coordinator.executeTask(task.prompt, executionContext, onProgress, {
    shouldCancel: () => isCancelled(task.id),
  });

  if (result.success) {
    await storage.updateTask(task.id, { status: TaskStatus.VALIDATING });

    if (result.staticValidation) {
      await storage.createExecutionLog({
        taskId: task.id,
        message: formatStaticResults(result.staticValidation),
        level: result.staticValidation.ok ? LogLevel.INFO : LogLevel.ERROR,
      });
    }

    if (result.validationPassed) {
      await createPRFromResult(task, result);
    } else {
      await storage.createExecutionLog({
        taskId: task.id,
        message: `DevOps validation did not pass — skipping PR creation. Reason: ${result.validationReason ?? 'unknown'}`,
        level: LogLevel.WARN,
      });
    }
  }

  return finalizeTask(task, result);
}
