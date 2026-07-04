/**
 * In-process registry of currently-executing tasks.
 *
 * Execution is fire-and-forget within the web process (no separate worker on the
 * free tier), so cancellation and timeouts are coordinated here: the executor
 * registers a task when it starts, the coordinator polls `isCancelled` between
 * agent steps, and the cancel endpoint (or the timeout guard) flips the flag.
 *
 * This state is intentionally in-memory and per-instance. It is a best-effort
 * control channel for the process that owns the run; the durable source of truth
 * for task status is the database. Tasks orphaned by a restart are handled
 * separately by the startup reconciler (storage.markInterruptedTasksFailed).
 */

interface RunControl {
  cancelled: boolean;
}

const running = new Map<string, RunControl>();

/** Marks a task as running in this process. Call when execution begins. */
export function registerTask(taskId: string): void {
  running.set(taskId, { cancelled: false });
}

/** Removes a task from the registry. Call in a finally when execution ends. */
export function unregisterTask(taskId: string): void {
  running.delete(taskId);
}

/** True if the task is currently executing in this process. */
export function isRunning(taskId: string): boolean {
  return running.has(taskId);
}

/**
 * Requests cancellation of a running task. Returns true if the task was running
 * in this process (and is now flagged), false if it was not found.
 */
export function requestCancel(taskId: string): boolean {
  const control = running.get(taskId);
  if (!control) return false;
  control.cancelled = true;
  return true;
}

/** Whether cancellation has been requested for the given task. */
export function isCancelled(taskId: string): boolean {
  return running.get(taskId)?.cancelled ?? false;
}
