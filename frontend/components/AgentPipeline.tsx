import React, { useState } from 'react';
import { AgentExecutionRecord, AgentType, TaskDetails, TaskStatus } from '../lib/api';

const ACTIVE_STATUSES: TaskStatus[] = ['PENDING', 'PLANNING', 'IN_PROGRESS', 'VALIDATING'];

interface AgentMeta {
  label: string;
  role: string;
  working: string;
}

const AGENT_META: Record<AgentType, AgentMeta> = {
  PRODUCT_MANAGER: {
    label: 'Product Manager',
    role: 'Requirements & scope',
    working: 'Analyzing requirements and defining the execution plan…',
  },
  ARCHITECT: {
    label: 'Architect',
    role: 'System design',
    working: 'Designing technical architecture and component structure…',
  },
  DATABASE: {
    label: 'Database',
    role: 'Schema & migrations',
    working: 'Planning data model changes and SQL migrations…',
  },
  BACKEND: {
    label: 'Backend',
    role: 'Server-side code',
    working: 'Writing API endpoints and server-side logic…',
  },
  FRONTEND: {
    label: 'Frontend',
    role: 'UI components',
    working: 'Building React components and interface views…',
  },
  DEVOPS: {
    label: 'DevOps',
    role: 'Validation & review',
    working: 'Reviewing correctness, security, and edge cases…',
  },
};

const PIPELINE_ORDER: AgentType[] = [
  'PRODUCT_MANAGER',
  'ARCHITECT',
  'DATABASE',
  'BACKEND',
  'FRONTEND',
  'DEVOPS',
];

type PipelineStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * The most recent execution for an agent. An agent whose files failed static
 * validation is re-run by the auto-repair pass, producing a second execution of
 * the same type — the latest one carries the corrected output, so we surface it.
 */
function latestExec(
  agentType: AgentType,
  executions: AgentExecutionRecord[]
): AgentExecutionRecord | undefined {
  const list = executions.filter((e) => e.agentType === agentType);
  if (list.length === 0) return undefined;
  return list.reduce((a, b) =>
    new Date(b.createdAt).getTime() >= new Date(a.createdAt).getTime() ? b : a
  );
}

function wasRepaired(agentType: AgentType, executions: AgentExecutionRecord[]): boolean {
  return executions.filter((e) => e.agentType === agentType).length > 1;
}

function getStatus(agentType: AgentType, executions: AgentExecutionRecord[]): PipelineStatus {
  const exec = latestExec(agentType, executions);
  if (!exec) return 'pending';
  if (exec.status === 'RUNNING') return 'running';
  if (exec.status === 'SUCCESS') return 'done';
  if (exec.status === 'FAILED') return 'failed';
  return 'pending';
}

function getOutputPreview(output: string): string {
  const files = tryParseFiles(output) ?? tryParseFiles(fixJsonEscapes(output));
  if (files && files.length > 0) {
    const count = files.length;
    const paths = files.slice(0, 2).map((f) => f.path).join(', ');
    return `${count} file${count === 1 ? '' : 's'} — ${paths}${count > 2 ? ', …' : ''}`;
  }
  const firstLine = output.split('\n').find((l) => l.trim()) ?? output;
  return firstLine.trim().slice(0, 100);
}

// ── Output parsing ────────────────────────────────────────────────────────────

interface ParsedFile {
  path: string;
  content: string;
}

type ParsedOutput =
  | { type: 'files'; files: ParsedFile[] }
  | { type: 'text'; content: string };

function fixJsonEscapes(raw: string): string {
  // LLMs emit invalid escape sequences like \w \d \s \. inside JSON string values.
  // Replace \X where X is not a valid JSON escape char with \\X.
  return raw.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
}

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) return fenced[1];
  return raw;
}

function tryParseFiles(candidate: string): ParsedFile[] | null {
  try {
    const j = JSON.parse(candidate) as { files?: ParsedFile[] };
    if (Array.isArray(j.files) && j.files.length > 0) return j.files;
  } catch {
    // ignore
  }
  return null;
}

function parseOutput(raw: string): ParsedOutput {
  const extracted = extractJsonObject(raw);
  const files =
    tryParseFiles(raw) ??
    tryParseFiles(extracted) ??
    tryParseFiles(fixJsonEscapes(raw)) ??
    tryParseFiles(fixJsonEscapes(extracted));

  if (files) return { type: 'files', files };
  return { type: 'text', content: raw };
}

function langBadge(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const M: Record<string, string> = {
    ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX',
    json: 'JSON', sql: 'SQL', md: 'MD', css: 'CSS',
    html: 'HTML', py: 'PY', sh: 'SH', yaml: 'YML',
    yml: 'YML', prisma: 'PR', env: 'ENV',
  };
  return M[ext] ?? (ext.toUpperCase() || 'TXT');
}

// ── Code viewer component ─────────────────────────────────────────────────────

function CopyButton({ getText }: { getText: () => string }) {
  const [label, setLabel] = useState<'copy' | 'copied'>('copy');

  function handleCopy() {
    void navigator.clipboard.writeText(getText()).then(() => {
      setLabel('copied');
      setTimeout(() => setLabel('copy'), 1600);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors px-2 py-1 rounded hover:bg-slate-800/50 select-none"
    >
      {label}
    </button>
  );
}

function CodeViewer({
  exec,
  onClose,
}: {
  exec: AgentExecutionRecord;
  onClose: () => void;
}) {
  const output = parseOutput(exec.output ?? '');
  const meta = AGENT_META[exec.agentType];

  const [selectedPath, setSelectedPath] = useState<string>(
    output.type === 'files' ? (output.files[0]?.path ?? '') : ''
  );

  const selectedFile =
    output.type === 'files' ? output.files.find((f) => f.path === selectedPath) ?? null : null;

  return (
    <div className="mt-3 rounded-xl border border-slate-700/40 bg-slate-950/70 overflow-hidden">
      {/* Viewer header */}
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-slate-800/50 bg-slate-900/30">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-slate-300 flex-shrink-0">{meta.label}</span>
          {output.type === 'files' && (
            <span className="text-[10px] font-mono text-slate-600">
              {output.files.length} file{output.files.length !== 1 ? 's' : ''}
            </span>
          )}
          {output.type === 'text' && (
            <span className="text-[10px] font-mono text-slate-600">plain text</span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <CopyButton
            getText={() =>
              output.type === 'files'
                ? (selectedFile?.content ?? '')
                : output.content
            }
          />
          <button
            type="button"
            onClick={onClose}
            className="text-slate-600 hover:text-slate-400 transition-colors p-1.5 rounded hover:bg-slate-800/50"
            aria-label="Close output viewer"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {output.type === 'files' ? (
        <div className="flex" style={{ height: '340px' }}>
          {/* File sidebar */}
          <div className="w-48 flex-shrink-0 border-r border-slate-800/50 overflow-y-auto bg-slate-950/40 py-1">
            {output.files.map((file) => {
              const isActive = file.path === selectedPath;
              const name = file.path.split('/').pop() ?? file.path;
              const dir = file.path.includes('/')
                ? file.path.split('/').slice(0, -1).join('/')
                : null;

              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  title={file.path}
                  className={`w-full text-left px-3 py-2 transition-colors group ${
                    isActive ? 'bg-blue-500/10 border-r-2 border-blue-500/50' : 'hover:bg-slate-800/30'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`text-[8px] font-mono px-1 py-px rounded flex-shrink-0 ${
                        isActive ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-800 text-slate-600'
                      }`}
                    >
                      {langBadge(file.path)}
                    </span>
                    <span
                      className={`text-[11px] font-mono truncate ${
                        isActive ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'
                      }`}
                    >
                      {name}
                    </span>
                  </div>
                  {dir && (
                    <p
                      className={`text-[9px] font-mono truncate mt-0.5 pl-[22px] ${
                        isActive ? 'text-slate-500' : 'text-slate-700'
                      }`}
                    >
                      {dir}
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          {/* Content pane */}
          <div className="flex-1 overflow-auto">
            {selectedFile ? (
              <table className="w-full border-collapse">
                <tbody>
                  {selectedFile.content.split('\n').map((line, i) => (
                    <tr key={i} className="group hover:bg-white/[0.02]">
                      <td className="select-none text-right text-[10px] font-mono text-slate-700 tabular-nums pr-4 pl-4 py-px align-top w-10 flex-shrink-0 leading-[1.7]">
                        {i + 1}
                      </td>
                      <td className="text-[11px] font-mono text-slate-300 pr-4 py-px whitespace-pre leading-[1.7]">
                        {line}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-sm text-slate-600">Select a file</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Plain text output (PM, Architect, DevOps) */
        <div className="overflow-y-auto" style={{ maxHeight: '340px' }}>
          <pre className="text-[12px] font-mono text-slate-300 leading-relaxed p-5 whitespace-pre-wrap">
            {output.content}
          </pre>
        </div>
      )}
    </div>
  );
}

// ── Node indicators ───────────────────────────────────────────────────────────

function NodeDone() {
  return (
    <div className="h-5 w-5 rounded-full bg-emerald-950 border border-emerald-500/50 flex items-center justify-center flex-shrink-0">
      <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
        <path
          d="M1.5 4.5l2 2L7.5 2"
          stroke="#34D399"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function NodeRunning() {
  return (
    <div className="relative h-5 w-5 flex-shrink-0 flex items-center justify-center">
      <div className="absolute inset-0 rounded-full border border-blue-400/20 animate-ping" />
      <div className="h-5 w-5 rounded-full border border-blue-400/50 bg-blue-950/60 flex items-center justify-center">
        <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
      </div>
    </div>
  );
}

function NodeFailed() {
  return (
    <div className="h-5 w-5 rounded-full bg-rose-950 border border-rose-500/50 flex items-center justify-center flex-shrink-0">
      <span className="text-rose-400 text-[9px] font-bold leading-none select-none">✕</span>
    </div>
  );
}

function NodePending({ index }: { index: number }) {
  return (
    <div className="h-5 w-5 rounded-full border border-slate-800 bg-slate-900/40 flex items-center justify-center flex-shrink-0">
      <span className="text-slate-700 text-[9px] font-mono leading-none">
        {String(index + 1).padStart(2, '0')}
      </span>
    </div>
  );
}

// ── Connector rail ────────────────────────────────────────────────────────────

function Connector({ top, bottom }: { top: PipelineStatus; bottom: PipelineStatus }) {
  const flowing = top === 'done' && bottom === 'running';
  const solid = top === 'done' && (bottom === 'done' || bottom === 'failed');

  return (
    <div className="relative w-px flex-1 my-0.5 overflow-hidden">
      {solid && <div className="absolute inset-0 bg-emerald-500/25" />}
      {flowing && <div className="absolute inset-0 pipeline-flow" />}
      {!solid && !flowing && <div className="absolute inset-0 bg-slate-800/70" />}
    </div>
  );
}

// ── Agent cards ───────────────────────────────────────────────────────────────

function RunningCard({ meta }: { meta: AgentMeta }) {
  return (
    <div className="rounded-xl border border-blue-500/20 bg-gradient-to-b from-blue-950/25 to-slate-900/10 overflow-hidden">
      <div className="h-px w-full relative overflow-hidden bg-blue-900/20">
        <div className="absolute top-0 left-0 h-full w-[45%] bg-gradient-to-r from-transparent via-blue-400/90 to-transparent pipeline-scan" />
      </div>
      <div className="px-4 py-3.5">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <span className="text-sm font-semibold text-white tracking-tight">{meta.label}</span>
          <span className="flex items-center gap-[3px]" aria-label="Working">
            <span className="h-[3px] w-[3px] rounded-full bg-blue-400/70 animate-bounce bounce-d0" />
            <span className="h-[3px] w-[3px] rounded-full bg-blue-400/70 animate-bounce bounce-d1" />
            <span className="h-[3px] w-[3px] rounded-full bg-blue-400/70 animate-bounce bounce-d2" />
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-blue-300/50">{meta.working}</p>
      </div>
    </div>
  );
}

function RepairedBadge() {
  return (
    <span
      title="This agent's output failed validation and was automatically re-generated and fixed."
      className="flex-shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-px text-[9px] font-mono uppercase tracking-wide bg-amber-500/10 text-amber-400/90 border border-amber-500/20 select-none"
    >
      <span aria-hidden="true">🔧</span> auto-repaired
    </span>
  );
}

function DoneCard({
  meta,
  exec,
  isActive,
  repaired,
  onClick,
}: {
  meta: AgentMeta;
  exec: AgentExecutionRecord;
  isActive: boolean;
  repaired: boolean;
  onClick: () => void;
}) {
  const preview = exec.output ? getOutputPreview(exec.output) : null;
  const hasOutput = Boolean(exec.output?.trim());

  return (
    <button
      type="button"
      onClick={hasOutput ? onClick : undefined}
      disabled={!hasOutput}
      className={`w-full text-left rounded-lg border px-4 py-2.5 transition-all duration-200 group ${
        isActive
          ? 'border-slate-600/60 bg-slate-800/40'
          : hasOutput
          ? 'border-slate-800/50 bg-slate-900/20 hover:border-slate-700/50 hover:bg-slate-800/20 cursor-pointer'
          : 'border-slate-800/50 bg-slate-900/20 cursor-default'
      }`}
    >
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-sm font-medium text-slate-300 flex-shrink-0">{meta.label}</span>
        {preview && (
          <>
            <span className="text-slate-700 text-xs flex-shrink-0 select-none">—</span>
            <span className="text-[11px] text-slate-500 font-mono truncate">{preview}</span>
          </>
        )}
        {repaired && <span className="ml-auto"><RepairedBadge /></span>}
        {hasOutput && (
          <span className={`${repaired ? '' : 'ml-auto'} flex-shrink-0 transition-transform duration-150 ${isActive ? 'rotate-90' : ''}`}>
            <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
              <path d="M2 1.5l4.5 3L2 7.5" stroke={isActive ? '#94a3b8' : '#475569'} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </div>
    </button>
  );
}

function FailedCard({ meta, exec }: { meta: AgentMeta; exec?: AgentExecutionRecord }) {
  return (
    <div className="rounded-lg border border-rose-900/40 bg-rose-950/15 px-4 py-2.5">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="text-sm font-medium text-rose-300 flex-shrink-0">{meta.label}</span>
        {exec?.error && (
          <span className="text-[11px] text-rose-500/80 truncate font-mono">{exec.error.slice(0, 70)}</span>
        )}
      </div>
    </div>
  );
}

function PendingCard({ meta }: { meta: AgentMeta }) {
  return (
    <div className="px-1 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-slate-600">{meta.label}</span>
        <span className="text-[11px] text-slate-700 truncate">{meta.role}</span>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AgentPipeline({ task }: { task: TaskDetails }) {
  const isLive = ACTIVE_STATUSES.includes(task.status);
  const [activeAgent, setActiveAgent] = useState<AgentType | null>(null);

  function toggleAgent(agentType: AgentType) {
    setActiveAgent((prev) => (prev === agentType ? null : agentType));
  }

  const activeExec = activeAgent
    ? latestExec(activeAgent, task.executions) ?? null
    : null;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-[10px] font-mono tracking-[0.18em] uppercase text-slate-500 select-none">
          Agent Pipeline
        </span>
        {isLive && (
          <span className="ml-auto flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[10px] text-blue-400/60 font-mono">live</span>
          </span>
        )}
      </div>

      {/* Agent list */}
      <div>
        {PIPELINE_ORDER.map((agentType, index) => {
          const status = getStatus(agentType, task.executions);
          const nextType = PIPELINE_ORDER[index + 1];
          const nextStatus = nextType ? getStatus(nextType, task.executions) : 'pending';
          const exec = latestExec(agentType, task.executions);
          const meta = AGENT_META[agentType];
          const repaired = wasRepaired(agentType, task.executions);
          const isLast = index === PIPELINE_ORDER.length - 1;
          const isActiveAgent = activeAgent === agentType;

          return (
            <div key={agentType} className="flex gap-3">
              {/* Rail */}
              <div className="flex flex-col items-center w-5 flex-shrink-0">
                {status === 'done'    && <NodeDone />}
                {status === 'running' && <NodeRunning />}
                {status === 'failed'  && <NodeFailed />}
                {status === 'pending' && <NodePending index={index} />}

                {!isLast && <Connector top={status} bottom={nextStatus} />}
              </div>

              {/* Card */}
              <div className={`flex-1 min-w-0 ${isLast ? '' : 'pb-2.5'}`}>
                {status === 'running' && <RunningCard meta={meta} />}
                {status === 'done' && exec && (
                  <>
                    <DoneCard
                      meta={meta}
                      exec={exec}
                      isActive={isActiveAgent}
                      repaired={repaired}
                      onClick={() => toggleAgent(agentType)}
                    />
                    {isActiveAgent && activeExec && (
                      <CodeViewer exec={activeExec} onClose={() => setActiveAgent(null)} />
                    )}
                  </>
                )}
                {status === 'failed'  && <FailedCard meta={meta} exec={exec} />}
                {status === 'pending' && <PendingCard meta={meta} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
