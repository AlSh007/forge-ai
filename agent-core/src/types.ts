export interface Agent {
  name: string;
  type: AgentType;
  run(input: string, context: ExecutionContext): Promise<string>;
}

export enum AgentType {
  PRODUCT_MANAGER = 'product-manager',
  ARCHITECT = 'architect',
  BACKEND = 'backend',
  FRONTEND = 'frontend',
  DATABASE = 'database',
  DEVOPS = 'devops',
}

export interface Tool {
  name: string;
  description: string;
  execute(input: unknown): Promise<unknown>;
}

export interface AgentResult {
  success: boolean;
  output: string;
  logs: string[];
  errors?: string[];
}

export interface AgentStepResult {
  agentType: AgentType;
  agentName: string;
  output?: string;
  error?: string;
}

export interface CodeChange {
  path: string;
  content: string;
}

export interface ValidationIssue {
  path: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface StaticValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  filesChecked: number;
}

export interface TaskExecutionResult {
  success: boolean;
  steps: AgentStepResult[];
  plan?: string;
  design?: string;
  dbChanges?: string;
  backendCode?: string;
  frontendCode?: string;
  validation?: string;
  validationPassed?: boolean;
  validationReason?: string;
  staticValidation?: StaticValidationResult;
  codeChanges?: CodeChange[];
  error?: string;
  /** True when execution stopped because cancellation was requested. */
  cancelled?: boolean;
}

/** Options controlling a single task execution run. */
export interface ExecuteTaskOptions {
  /**
   * Polled between agent steps. When it returns true, execution stops at the next
   * step boundary and the result is returned with `cancelled: true`. Used for both
   * user-requested cancellation and the timeout guard.
   */
  shouldCancel?: () => boolean | Promise<boolean>;
}

export interface RepoContext {
  structure: string;
  keyFiles: Record<string, string>;
  framework?: string;
  dependencies?: string[];
}

/**
 * On-demand access to the target repository, injected by the host (the backend
 * implements it over the GitHub API). Lets agents read files that weren't in the
 * pre-fetched snapshot instead of generating code against truncated context.
 */
export interface RepoAccess {
  /** Returns file contents, or null if the path does not exist. */
  readFile(path: string): Promise<string | null>;
  /** All file paths in the repository. */
  listFiles(): Promise<string[]>;
  /** File paths whose path contains the (case-insensitive) query substring. */
  searchFiles(query: string): Promise<string[]>;
}

export interface ExecutionContext {
  taskId: string;
  repository: string;
  branch: string;
  userId: string;
  environment: {
    nodeVersion?: string;
    pythonVersion?: string;
    framework?: string;
  };
  repoContext?: RepoContext;
  repoAccess?: RepoAccess;
}

export type AgentProgressEvent = {
  agentType: AgentType;
  agentName: string;
  status: 'started' | 'completed' | 'failed';
  /** The full prompt the agent received. Present on the 'started' event. */
  input?: string;
  output?: string;
  error?: string;
};

export type ProgressCallback = (event: AgentProgressEvent) => void | Promise<void>;
