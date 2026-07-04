import axios from 'axios';
import { supabase } from './supabase';

export type TaskStatus =
  | 'PENDING'
  | 'PLANNING'
  | 'IN_PROGRESS'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type AgentType =
  | 'PRODUCT_MANAGER'
  | 'ARCHITECT'
  | 'BACKEND'
  | 'FRONTEND'
  | 'DATABASE'
  | 'DEVOPS';

export type ExecutionStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type PullRequestStatus =
  | 'DRAFT'
  | 'READY'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'MERGED'
  | 'REJECTED';

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

export interface PullRequestRecord {
  id: string;
  taskId: string;
  branchName: string;
  prUrl: string | null;
  status: PullRequestStatus;
  title: string;
  description: string | null;
  changes: string | null;
  validationResults: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetails {
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

export interface TaskListResponse {
  tasks: TaskDetails[];
}

export interface TaskResponse {
  task: TaskDetails;
}

export interface ExecutionListResponse {
  executions: AgentExecutionRecord[];
}

export interface PullRequestListResponse {
  pullRequests: PullRequestRecord[];
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach the current Supabase access token (JWT) to every request. The backend
// verifies it and resolves the authenticated user.
apiClient.interceptors.request.use(async (config) => {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// On 401 the session is invalid/expired — sign out so the app returns to login.
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error?.response?.status === 401) {
      await supabase.auth.signOut();
    }
    return Promise.reject(error);
  }
);

export interface UserProfile {
  email: string;
  name: string | null;
  githubUsername: string | null;
  hasGithubToken: boolean;
}

export const authApi = {
  me: async (): Promise<{ user: UserProfile }> => (await apiClient.get('/api/auth/me')).data,
  storeGithubToken: async (providerToken: string, githubUsername?: string): Promise<void> => {
    await apiClient.post('/api/auth/github', { providerToken, githubUsername });
  },
};

// Task API calls
export const taskApi = {
  getAll: async (): Promise<TaskListResponse> => (await apiClient.get('/api/tasks')).data,
  getById: async (id: string): Promise<TaskResponse> => (await apiClient.get(`/api/tasks/${id}`)).data,
  create: async (data: { prompt: string; repositoryUrl: string }): Promise<TaskResponse> =>
    (await apiClient.post('/api/tasks', data)).data,
};

// Execution API calls
export const executionApi = {
  getByTaskId: async (taskId: string): Promise<ExecutionListResponse> =>
    (await apiClient.get(`/api/executions?taskId=${taskId}`)).data,
  startExecution: async (taskId: string): Promise<TaskResponse> =>
    (await apiClient.post(`/api/tasks/${taskId}/execute`)).data,
  cancel: async (taskId: string): Promise<TaskResponse> =>
    (await apiClient.post(`/api/tasks/${taskId}/cancel`)).data,
};

export const systemApi = {
  health: async (): Promise<{ status: string; storage: string }> =>
    (await apiClient.get('/health')).data,
};

// PullRequest API calls
export const prApi = {
  getByTaskId: async (taskId: string): Promise<PullRequestListResponse> =>
    (await apiClient.get(`/api/pull-requests?taskId=${taskId}`)).data,
};
