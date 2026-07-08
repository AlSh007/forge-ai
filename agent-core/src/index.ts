import { AgentStepResult, CodeChange, ExecuteTaskOptions, ExecutionContext, ProgressCallback, RepairSummary, StaticValidationResult, TaskExecutionResult } from './types';
import {
  ProductManagerAgent,
  ArchitectAgent,
  BackendAgent,
  FrontendAgent,
  DatabaseAgent,
  DevOpsAgent,
} from './agents/base';
import { validateChanges, formatStaticResults } from './validation/static';

// Keep accumulated context below this to avoid token-per-minute rate limits
const MAX_CONTEXT_CHARS = 24_000;

/** Thrown internally when a run is cancelled between steps. Not an execution failure. */
class TaskCancelledError extends Error {
  constructor() {
    super('Task cancelled');
    this.name = 'TaskCancelledError';
  }
}

function truncate(text: string, maxChars = MAX_CONTEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated]';
}

/**
 * Extracts the DevOps verdict from its review output. Looks for the
 * machine-readable `VERDICT: PASS|FAIL — reason` line the agent is instructed
 * to emit. If no verdict can be parsed, the change is treated as NOT passing —
 * a validation gate should fail closed, not open.
 */
function parseVerdict(validation: string): { passed: boolean; reason: string } {
  const matches = [...validation.matchAll(/VERDICT:\s*(PASS|FAIL)\s*[—\-:]?\s*(.*)/gi)];
  const last = matches[matches.length - 1];
  if (!last) {
    return { passed: false, reason: 'No machine-readable verdict found in DevOps review.' };
  }
  return {
    passed: last[1].toUpperCase() === 'PASS',
    reason: last[2]?.trim() || (last[1].toUpperCase() === 'PASS' ? 'Passed.' : 'Failed.'),
  };
}

/**
 * LLMs often emit invalid JSON escape sequences inside file content strings —
 * e.g. regex chars like \w \d \s \. that are not valid JSON escapes.
 * This normalises those by doubling the backslash before the parse attempt.
 */
function fixJsonEscapes(raw: string): string {
  return raw.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
}

/**
 * LLMs embedding TypeScript code (especially regex literals) in JSON often write
 * `\/` (a valid JSON escape for `/`) instead of `\\/` (literal backslash + slash).
 * JSON.parse then strips the backslash, turning regex `\/\/` into `//` which breaks
 * TypeScript syntax. This pass re-expands `\/` inside JSON strings to `\\/` so the
 * backslash survives parsing.
 */
function fixSlashEscapes(raw: string): string {
  let inString = false;
  let escaped = false;
  let result = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      // If we see `\/`, expand to `\\/` so the backslash survives JSON.parse.
      if (ch === '/') {
        result += '\\\\/';  // Add extra backslash so JSON.parse preserves it
      } else {
        result += ch;
      }
      escaped = false;
    } else if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
      result += ch;
    } else {
      result += ch;
    }
  }

  return result;
}

/**
 * LLMs also frequently output literal newlines (and other control chars) inside
 * JSON string values, making the JSON invalid. This walks the string character
 * by character, tracking whether we are inside a JSON string, and escapes any
 * bare control characters to their JSON escape equivalents.
 */
function fixLiteralNewlines(raw: string): string {
  let inString = false;
  let escaped = false;
  let result = '';

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      result += ch;
      escaped = false;
    } else if (ch === '\\' && inString) {
      result += ch;
      escaped = true;
    } else if (ch === '"') {
      inString = !inString;
      result += ch;
    } else if (inString && ch === '\n') {
      result += '\\n';
    } else if (inString && ch === '\r') {
      result += '\\r';
    } else if (inString && ch === '\t') {
      result += '\\t';
    } else {
      result += ch;
    }
  }

  return result;
}

function extractJsonObject(raw: string): string {
  // Strip thinking blocks some models emit before the actual content.
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // Strip markdown code fences (```json ... ```)
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) return fenced[1];
  return stripped;
}

/** The three agents that emit code files, in the order they run. */
const CODE_AGENT_NAMES = ['Database', 'Backend', 'Frontend'] as const;
type CodeAgentName = (typeof CODE_AGENT_NAMES)[number];

function errorCount(result: StaticValidationResult): number {
  return result.issues.filter((i) => i.severity === 'error').length;
}

function parseCodeChanges(output: string): CodeChange[] {
  const base = extractJsonObject(output);
  const nl = fixLiteralNewlines(output);
  const nlBase = fixLiteralNewlines(base);
  // Order matters: try the most-complete repairs first so the first successful
  // parse gives the highest-fidelity content (backslashes preserved for regex).
  const candidates = [
    output,
    base,
    fixJsonEscapes(fixSlashEscapes(nl)),
    fixJsonEscapes(fixSlashEscapes(nlBase)),
    fixJsonEscapes(nl),
    fixJsonEscapes(nlBase),
    fixSlashEscapes(nl),
    fixSlashEscapes(nlBase),
    fixJsonEscapes(output),
    fixJsonEscapes(base),
    nl,
    nlBase,
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { files?: CodeChange[] };
      if (Array.isArray(parsed.files)) return parsed.files;
    } catch {
      // try next candidate
    }
  }
  return [];
}

/** Normalises content for echo detection — ignores line-ending and trailing-whitespace noise. */
function normalizeContent(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
}

/**
 * Parses each code agent's output into CodeChange[] and assembles the final set, while:
 *  - warning when an agent clearly tried to emit files but the JSON could not be parsed
 *    (otherwise a parse failure is indistinguishable from a genuine "no changes"), and
 *  - dropping files whose content is byte-for-byte identical to what the agent was shown
 *    (no-op echoes that would otherwise produce an empty-diff PR).
 */
function collectCodeChanges(
  agentOutputs: Array<{ name: string; output: string }>,
  repoContext?: ExecutionContext['repoContext']
): CodeChange[] {
  const keyFiles = repoContext?.keyFiles ?? {};
  const collected: CodeChange[] = [];

  for (const { name, output } of agentOutputs) {
    const parsed = parseCodeChanges(output);
    const trimmed = output.trim();
    // Output mentions a non-empty files array but nothing parsed → malformed JSON, not "no changes".
    const claimedFiles = /"files"\s*:\s*\[\s*\{/.test(trimmed);
    if (parsed.length === 0 && claimedFiles) {
      console.warn(
        `[coordinator] ${name} emitted a non-empty files array that could not be parsed into code changes ` +
          `(likely malformed JSON escaping). Output length: ${trimmed.length} chars. No files collected from this agent.`
      );
    }
    collected.push(...parsed);
  }

  return collected.filter((change) => {
    const original = keyFiles[change.path];
    if (original != null && normalizeContent(change.content) === normalizeContent(original)) {
      console.warn(`[coordinator] Dropping ${change.path}: generated content is identical to the existing file (no-op echo).`);
      return false;
    }
    return true;
  });
}

const BUILD_ARTIFACT_SEGMENTS = new Set(['.next', 'node_modules', 'dist', 'build', 'coverage', 'out', '.git']);

/**
 * Filters the raw file tree (one path per line) down to source files only.
 * Drops build artifacts at any depth (.next, node_modules, dist, etc).
 */
function filterStructure(structure: string): string {
  return structure
    .split('\n')
    .filter((p) => {
      const segments = p.split('/');
      if (segments.some((s) => BUILD_ARTIFACT_SEGMENTS.has(s))) return false;
      if (p.endsWith('.pack') || p.endsWith('.pack.gz') || p.endsWith('.tsbuildinfo')) return false;
      return true;
    })
    .join('\n');
}

/**
 * Light section for planning agents (PM, Architect) — filtered file tree and deps only.
 * Fits in an 8K-context model and stays well under Groq TPM limits.
 */
function buildLightRepoSection(context: ExecutionContext): string {
  const { repoContext } = context;
  if (!repoContext) return '';
  const filteredTree = filterStructure(repoContext.structure);
  return `
## Repository: ${context.repository}
## Framework: ${repoContext.framework ?? 'unknown'}
## Dependencies: ${(repoContext.dependencies ?? []).slice(0, 30).join(', ')}

## Repository File Structure (source files only)
\`\`\`
${filteredTree}
\`\`\`
`.trim();
}

/**
 * Full section for code-generating agents — includes key files so agents have
 * concrete patterns to follow before they start reading with tools.
 * Limited to 6 files × 5000 chars to stay within TPM budgets.
 */
function buildRepoSection(context: ExecutionContext): string {
  const { repoContext } = context;
  if (!repoContext) return '';

  const keyFilesSection = Object.entries(repoContext.keyFiles)
    .slice(0, 10)
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``)
    .join('\n\n');

  const filteredTree = filterStructure(repoContext.structure);
  return `
## Repository: ${context.repository}
## Framework: ${repoContext.framework ?? 'unknown'}
## Dependencies: ${(repoContext.dependencies ?? []).slice(0, 30).join(', ')}

## Repository File Structure (source files only)
\`\`\`
${filteredTree}
\`\`\`

## Key File Contents (representative sample — use tools to read any file)
${keyFilesSection}
`.trim();
}

export class AgentCoordinator {
  private agents = {
    productManager: new ProductManagerAgent(),
    architect: new ArchitectAgent(),
    backend: new BackendAgent(),
    frontend: new FrontendAgent(),
    database: new DatabaseAgent(),
    devops: new DevOpsAgent(),
  };

  async executeTask(
    prompt: string,
    context: ExecutionContext,
    onProgress?: ProgressCallback,
    options?: ExecuteTaskOptions
  ): Promise<TaskExecutionResult> {
    const steps: AgentStepResult[] = [];
    console.log(`\nStarting task execution for: ${prompt}\n`);

    // Checked before each agent step. Throws TaskCancelledError so the outer
    // catch can distinguish a user/timeout cancellation from a real failure.
    const checkCancelled = async (): Promise<void> => {
      if (options?.shouldCancel && (await options.shouldCancel())) {
        throw new TaskCancelledError();
      }
    };

    // Planning agents (PM, Architect) get just the file tree to stay under
    // the 6K TPM limit of llama-3.1-8b-instant.
    const lightSection = buildLightRepoSection(context);
    const plannerBase = `## Task\n${prompt}\n\n${lightSection}`;
    // Code agents get the full key-file sample so they can write code that
    // matches existing patterns without needing tool calls (which burn 70B TPM).
    const codeSection = buildRepoSection(context);
    const codeBase = `## Task\n${prompt}\n\n${codeSection}`;

    // Database has no tools — inject just the schema-related key files so it
    // can decide if changes are required without burning the tool-call budget.
    const schemaFiles = Object.entries(context.repoContext?.keyFiles ?? {})
      .filter(([p]) => p.endsWith('.prisma') || p.includes('schema') || p.includes('migration'))
      .slice(0, 3)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 5000)}\n\`\`\``)
      .join('\n\n');
    const dbBase = schemaFiles ? `${plannerBase}\n\n## Schema Files\n${schemaFiles}` : plannerBase;

    try {
      await checkCancelled();
      const plan = await this.runStep(
        this.agents.productManager,
        plannerBase,
        context,
        steps,
        onProgress
      );

      await checkCancelled();
      const design = await this.runStep(
        this.agents.architect,
        truncate(`${plannerBase}\n\n## Execution Plan\n${plan}`, 12_000),
        context,
        steps,
        onProgress
      );

      await checkCancelled();
      const dbChanges = await this.runStep(
        this.agents.database,
        truncate(`${dbBase}\n\n## Execution Plan\n${plan}\n\n## Architecture Design\n${design}`),
        context,
        steps,
        onProgress
      );

      await checkCancelled();
      const backendCode = await this.runStep(
        this.agents.backend,
        truncate(`${codeBase}\n\n## Execution Plan\n${plan}\n\n## Architecture Design\n${design}\n\n## Database Changes\n${dbChanges}`),
        context,
        steps,
        onProgress
      );

      await checkCancelled();
      const frontendCode = await this.runStep(
        this.agents.frontend,
        // Backend changes are intentionally omitted — when included, the model
        // sometimes echoes backend code as frontend output.
        truncate(`${codeBase}\n\n## Execution Plan\n${plan}\n\n## Architecture Design\n${design}`),
        context,
        steps,
        onProgress
      );

      // Collect generated files and statically validate them before the DevOps
      // review, so the reviewer reasons over real, deterministic findings.
      const repoPaths = context.repoContext?.structure
        ? context.repoContext.structure.split('\n').map((p) => p.trim()).filter(Boolean)
        : [];
      const validateOutputs = (outputs: Record<CodeAgentName, string>) => {
        const changes = collectCodeChanges(
          CODE_AGENT_NAMES.map((name) => ({ name, output: outputs[name] })),
          context.repoContext
        );
        return { changes, result: validateChanges(changes, context.repoContext?.keyFiles, repoPaths) };
      };

      const codeOutputs: Record<CodeAgentName, string> = {
        Database: dbChanges,
        Backend: backendCode,
        Frontend: frontendCode,
      };
      let { changes: codeChanges, result: staticValidation } = validateOutputs(codeOutputs);
      let repair: RepairSummary | undefined;

      // Repair loop: when the deterministic checks fail, feed the exact errors
      // back to the agents that produced the offending files for one corrective
      // pass. The repaired output is adopted only if it strictly reduces the
      // error count, so a botched repair can never make the result worse.
      if (!staticValidation.ok) {
        const errorsBefore = errorCount(staticValidation);
        const { outputs: repaired, agents: repairedAgents } = await this.repairCodeOutputs(codeOutputs, staticValidation, context, steps, onProgress, checkCancelled);
        const { changes: repairedChanges, result: repairedValidation } = validateOutputs(repaired);
        const errorsAfter = errorCount(repairedValidation);
        const adopted = errorsAfter < errorsBefore;
        if (adopted) {
          console.log(`[coordinator] Repair pass reduced static errors ${errorsBefore} → ${errorsAfter}.`);
          Object.assign(codeOutputs, repaired);
          codeChanges = repairedChanges;
          staticValidation = repairedValidation;
        } else {
          console.log(`[coordinator] Repair pass did not reduce static errors (${errorsBefore}) — keeping original output.`);
        }
        repair = { agents: repairedAgents, errorsBefore, errorsAfter, adopted };
      }
      const staticSection = formatStaticResults(staticValidation);

      await checkCancelled();
      // DevOps only needs the task, the plan, and the generated files — not the
      // full repo key-file snapshot. Using plannerBase keeps this under 8K tokens.
      const validation = await this.runStep(
        this.agents.devops,
        truncate(
          `${plannerBase}\n\n## Execution Plan\n${plan}\n\n## Architecture Design\n${design}\n\n## Database Changes\n${codeOutputs.Database}\n\n## Backend Changes\n${codeOutputs.Backend}\n\n## Frontend Changes\n${codeOutputs.Frontend}\n\n## Static Validation Results (deterministic, authoritative)\n${staticSection}`,
          20_000
        ),
        context,
        steps,
        onProgress
      );

      // The change ships only if BOTH the deterministic checks pass and the
      // reviewer signs off. Static failures override a PASS verdict.
      const verdict = parseVerdict(validation);
      const validationPassed = staticValidation.ok && verdict.passed;
      const validationReason = !staticValidation.ok
        ? `Static validation failed: ${staticValidation.issues.filter((i) => i.severity === 'error').length} error(s). ${verdict.reason}`
        : verdict.reason;

      console.log(`\nTask execution completed — static: ${staticValidation.ok ? 'OK' : 'FAIL'}, DevOps verdict: ${verdict.passed ? 'PASS' : 'FAIL'} (${validationReason})`);

      return {
        success: true,
        steps,
        plan,
        design,
        dbChanges: codeOutputs.Database,
        backendCode: codeOutputs.Backend,
        frontendCode: codeOutputs.Frontend,
        validation,
        validationPassed,
        validationReason,
        staticValidation,
        repair,
        codeChanges,
      };
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        console.log('Task execution cancelled before completion.');
        return { success: false, cancelled: true, steps, error: 'Task cancelled.' };
      }
      console.error('Task execution failed:', error);
      return {
        success: false,
        steps,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Single corrective pass over the code agents whose files failed static
   * validation. Each such agent is re-prompted with its previous output and the
   * exact, deterministic errors, and asked to return corrected files. Errors that
   * can't be attributed to a specific file (e.g. a change missing its path) are
   * routed to every agent that produced files. Best-effort: an agent whose repair
   * attempt throws or yields no parseable files keeps its original output — the
   * caller only adopts the result if it reduces the total error count.
   */
  private async repairCodeOutputs(
    codeOutputs: Record<CodeAgentName, string>,
    validation: StaticValidationResult,
    context: ExecutionContext,
    steps: AgentStepResult[],
    onProgress: ProgressCallback | undefined,
    checkCancelled: () => Promise<void>
  ): Promise<{ outputs: Record<CodeAgentName, string>; agents: string[] }> {
    const errors = validation.issues.filter((i) => i.severity === 'error');
    if (errors.length === 0) return { outputs: codeOutputs, agents: [] };

    const agentByName = {
      Database: this.agents.database,
      Backend: this.agents.backend,
      Frontend: this.agents.frontend,
    };

    // Map each generated file path to the agent that first produced it.
    const owner = new Map<string, CodeAgentName>();
    for (const name of CODE_AGENT_NAMES) {
      for (const change of parseCodeChanges(codeOutputs[name])) {
        const p = (change.path ?? '').trim();
        if (p && !owner.has(p)) owner.set(p, name);
      }
    }

    const hasUnowned = errors.some((e) => !owner.has(e.path.trim()));
    const producers = CODE_AGENT_NAMES.filter((name) => parseCodeChanges(codeOutputs[name]).length > 0);
    const toRepair = new Set<CodeAgentName>();
    for (const e of errors) {
      const name = owner.get(e.path.trim());
      if (name) toRepair.add(name);
    }
    if (hasUnowned) producers.forEach((n) => toRepair.add(n));

    const repaired: Record<CodeAgentName, string> = { ...codeOutputs };
    const repairedAgents: string[] = [];
    for (const name of CODE_AGENT_NAMES) {
      if (!toRepair.has(name)) continue;
      repairedAgents.push(name);
      await checkCancelled();

      const relevant = errors.filter((e) => owner.get(e.path.trim()) === name || !owner.has(e.path.trim()));
      const errorList = relevant.map((e) => `- ${e.path}: ${e.message}`).join('\n');
      const agent = agentByName[name];
      const repairInput =
        `Your previous output for this task failed deterministic validation. Fix every error and return the corrected files.\n\n` +
        `## Your previous output\n${truncate(codeOutputs[name], 12_000)}\n\n` +
        `## Validation errors (deterministic and authoritative — each MUST be resolved)\n${errorList}\n\n` +
        `## Instructions\n` +
        `- Return the COMPLETE corrected set of changed files as {"files":[{"path":"...","content":"..."}]} JSON — the same format as before.\n` +
        `- For a dangling import: either add the missing file to "files" with real content, or change the import to a path that already exists.\n` +
        `- For a syntax or JSON error: emit valid, complete file content.\n` +
        `- Do not re-emit files that were already correct, and do not introduce new errors.`;

      try {
        const out = await this.runStep(
          { name: `${agent.name} (repair)`, type: agent.type, run: agent.run.bind(agent) },
          repairInput,
          context,
          steps,
          onProgress
        );
        if (parseCodeChanges(out).length > 0) repaired[name] = out;
      } catch (err) {
        if (err instanceof TaskCancelledError) throw err;
        console.warn(`[coordinator] Repair pass for ${name} failed: ${err instanceof Error ? err.message : 'unknown'}. Keeping original output.`);
      }
    }
    return { outputs: repaired, agents: repairedAgents };
  }

  private async runStep(
    agent: {
      name: string;
      type: AgentStepResult['agentType'];
      run: (input: string, context: ExecutionContext) => Promise<string>;
    },
    input: string,
    context: ExecutionContext,
    steps: AgentStepResult[],
    onProgress?: ProgressCallback
  ): Promise<string> {
    await onProgress?.({ agentType: agent.type, agentName: agent.name, status: 'started', input });
    try {
      const output = await agent.run(input, context);
      steps.push({ agentType: agent.type, agentName: agent.name, output });
      await onProgress?.({ agentType: agent.type, agentName: agent.name, status: 'completed', output });
      return output;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      steps.push({ agentType: agent.type, agentName: agent.name, error: errMsg });
      await onProgress?.({ agentType: agent.type, agentName: agent.name, status: 'failed', error: errMsg });
      throw error;
    }
  }
}

export * from './types';
export { validateChanges, formatStaticResults } from './validation/static';
