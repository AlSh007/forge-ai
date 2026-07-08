// Stub the LLM so the coordinator runs offline. Behaviour is keyed off the
// system prompt (which agent) and the input (whether it's a repair re-prompt):
//  - repair pass  → Frontend returns a file with the import path corrected
//  - Frontend     → first pass returns a file with a dangling import
//  - everything else → plain text (PM/Architect/Database/Backend/DevOps)
jest.mock('./llm/client', () => ({
  callLLM: jest.fn(async (system: string, input: string) => {
    if (typeof input === 'string' && input.includes('failed deterministic validation')) {
      return '{"files":[{"path":"frontend/pages/x.tsx","content":"import { api } from \'../lib/api\';\\nexport default function X(){ return api ? null : null; }"}]}';
    }
    if (typeof system === 'string' && system.includes('frontend engineer')) {
      return '{"files":[{"path":"frontend/pages/x.tsx","content":"import { api } from \'../lib/missing\';\\nexport default function X(){ return api ? null : null; }"}]}';
    }
    return 'STUB_OUTPUT';
  }),
  callLLMWithTools: jest.fn(async () => '{"files":[]}'),
}));

import { AgentCoordinator, AgentProgressEvent, ExecutionContext } from './index';

function makeContext(): ExecutionContext {
  return {
    taskId: 't1',
    repository: 'owner/repo',
    branch: 'forge/t1',
    userId: 'u1',
    environment: {},
  };
}

describe('AgentCoordinator input threading', () => {
  it('emits each agent input on its started event', async () => {
    const coordinator = new AgentCoordinator();
    const started: AgentProgressEvent[] = [];

    await coordinator.executeTask('Add a health endpoint', makeContext(), (event) => {
      if (event.status === 'started') started.push(event);
    });

    // All six agents announced a start carrying a non-empty input.
    expect(started).toHaveLength(6);
    for (const event of started) {
      expect(typeof event.input).toBe('string');
      expect(event.input && event.input.length).toBeGreaterThan(0);
      expect(event.input).toContain('Add a health endpoint');
    }
  });

  it('threads a prior agent output into a later agent input', async () => {
    const coordinator = new AgentCoordinator();
    const started: AgentProgressEvent[] = [];

    await coordinator.executeTask('Add a health endpoint', makeContext(), (event) => {
      if (event.status === 'started') started.push(event);
    });

    // The Architect (second agent) input should include the PM's output.
    expect(started[1].input).toContain('STUB_OUTPUT');
  });
});

describe('AgentCoordinator repair loop', () => {
  function makeContextWithRepo(): ExecutionContext {
    return {
      taskId: 't1',
      repository: 'owner/repo',
      branch: 'forge/t1',
      userId: 'u1',
      environment: {},
      // Full file tree so relative-import resolution can run. `../lib/api`
      // exists; `../lib/missing` (the first-pass import) does not.
      repoContext: { structure: 'frontend/lib/api.ts\nfrontend/pages/index.tsx', keyFiles: {} },
    };
  }

  it('feeds a dangling import back to the agent and adopts the corrected output', async () => {
    const coordinator = new AgentCoordinator();
    const result = await coordinator.executeTask('Add a page', makeContextWithRepo());

    // The repaired output resolves the import, so static validation now passes.
    expect(result.staticValidation?.ok).toBe(true);
    expect(
      result.codeChanges?.some((c) => c.path === 'frontend/pages/x.tsx' && c.content.includes('../lib/api'))
    ).toBe(true);
    // A distinct repair step was recorded for the offending agent.
    expect(result.steps.some((s) => s.agentName === 'Frontend (repair)')).toBe(true);
    // Only the agent that owned the broken file was repaired.
    expect(result.steps.filter((s) => s.agentName?.includes('(repair)'))).toHaveLength(1);

    // The repair summary is reported for the UI/logs to surface.
    expect(result.repair).toBeDefined();
    expect(result.repair?.adopted).toBe(true);
    expect(result.repair?.agents).toEqual(['Frontend']);
    expect(result.repair?.errorsBefore).toBeGreaterThan(0);
    expect(result.repair?.errorsAfter).toBe(0);
  });

  it('does not report a repair when validation passes on the first try', async () => {
    const coordinator = new AgentCoordinator();
    // No repoContext → relative-import checks are skipped, so nothing fails.
    const result = await coordinator.executeTask('Add a page', {
      taskId: 't2',
      repository: 'owner/repo',
      branch: 'forge/t2',
      userId: 'u1',
      environment: {},
    });
    expect(result.repair).toBeUndefined();
    expect(result.steps.some((s) => s.agentName?.includes('(repair)'))).toBe(false);
  });
});
