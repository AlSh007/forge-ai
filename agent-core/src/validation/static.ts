import * as ts from 'typescript';
import { CodeChange, StaticValidationResult, ValidationIssue } from '../types';

// Files an agent must never regenerate — overwriting these breaks the repo.
const PROTECTED_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

// The coordinator appends this marker when it truncates oversized context; if it
// shows up inside generated file content, the file was cut off mid-stream.
const TRUNCATION_MARKER = '... [truncated]';

const TS_LIKE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

// Cap diagnostics per file so a single malformed file can't flood the report.
const MAX_SYNTAX_ISSUES_PER_FILE = 5;
const MAX_IMPORT_ISSUES_PER_FILE = 5;

// Extensions a bare relative specifier (e.g. `./user`) may resolve to, plus the
// index-file variants tried for a directory import.
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

function extname(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot === -1 ? '' : basename.slice(dot).toLowerCase();
}

/** Forward-slashes, strips a leading `./`, and drops any trailing slash. */
function normalizePath(p: string): string {
  const s = p.replace(/\\/g, '/').trim().replace(/^\.\//, '').replace(/\/+$/, '');
  return s;
}

/** Resolves a relative specifier against the importing file's directory, collapsing `.`/`..`. */
function joinAndNormalize(fromDir: string, spec: string): string {
  const parts = fromDir ? fromDir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * True if a relative import specifier resolves to a file we know exists — either
 * one of the generated files or a file already in the repository tree. Mirrors
 * TS/Node resolution: exact path, appended extensions, `.js`→`.ts` rewrite for
 * ESM-style explicit extensions, and `index.*` for directory imports.
 */
function resolvesToKnownFile(fromPath: string, spec: string, knownPaths: Set<string>): boolean {
  const fromDir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const base = joinAndNormalize(fromDir, spec);

  const candidates = [base];
  for (const ext of RESOLVABLE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of INDEX_EXTENSIONS) candidates.push(base + '/index' + ext);
  // ESM emits import paths with a `.js` extension that map to `.ts` sources.
  const jsExt = base.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsExt) {
    const stem = base.slice(0, base.length - jsExt[0].length);
    candidates.push(stem + '.ts', stem + '.tsx', stem + '.d.ts');
  }

  return candidates.some((c) => knownPaths.has(c));
}

/**
 * Flags relative imports that point at a file which exists neither among the
 * generated files nor in the repository — the "compiles but is dead on arrival"
 * failure the per-file syntax check cannot see (it runs with `noResolve`). Only
 * relative specifiers are checked: bare/aliased specifiers (`express`, `@/x`)
 * depend on install state and tsconfig paths we can't verify deterministically.
 */
function checkImports(path: string, normalizedPath: string, content: string, knownPaths: Set<string>): ValidationIssue[] {
  let importedFiles: ReadonlyArray<{ fileName: string }>;
  try {
    importedFiles = ts.preProcessFile(content, true, true).importedFiles;
  } catch {
    return []; // Extraction is best-effort; syntax errors are reported elsewhere.
  }

  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const ref of importedFiles) {
    const spec = ref.fileName;
    if (!spec.startsWith('.')) continue; // only relative imports are verifiable here
    if (seen.has(spec)) continue;
    seen.add(spec);
    if (!resolvesToKnownFile(normalizedPath, spec, knownPaths)) {
      issues.push({
        path,
        severity: 'error',
        message: `Imports "${spec}" which resolves to no generated file or existing repository file (dangling import).`,
      });
      if (issues.length >= MAX_IMPORT_ISSUES_PER_FILE) break;
    }
  }
  return issues;
}

/**
 * Deterministic, dependency-free validation of generated files. Runs no untrusted
 * code and resolves no imports — it only checks the artifacts themselves for the
 * failure modes LLMs actually produce: malformed JSON, syntax errors, empty or
 * truncated content, and unsafe paths. Real ground truth to back the DevOps verdict.
 */
export function validateChanges(
  changes: CodeChange[],
  originals: Record<string, string> = {},
  repoPaths: string[] = []
): StaticValidationResult {
  const issues: ValidationIssue[] = [];

  // Every path we can prove exists: the repository tree, the sampled originals,
  // and the files this run is generating (so cross-references between generated
  // files resolve). Relative-import resolution is skipped entirely when no repo
  // tree is supplied — without it we cannot tell "missing" from "unknown".
  const knownPaths = new Set<string>();
  for (const p of repoPaths) {
    const n = normalizePath(p);
    if (n) knownPaths.add(n);
  }
  for (const p of Object.keys(originals)) knownPaths.add(normalizePath(p));
  for (const c of changes) {
    if (c?.path) knownPaths.add(normalizePath(c.path.trim()));
  }
  const canCheckImports = repoPaths.length > 0;

  for (const change of changes) {
    const path = (change?.path ?? '').trim();
    const content = change?.content ?? '';

    if (!path) {
      issues.push({ path: '(missing)', severity: 'error', message: 'Generated change has no file path.' });
      continue;
    }

    const normalized = path.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const basename = segments[segments.length - 1] ?? '';

    // Path safety — must stay inside the repo and not clobber lockfiles.
    if (normalized.startsWith('/') || segments.includes('..')) {
      issues.push({ path, severity: 'error', message: 'Path escapes the repository root.' });
    }
    if (PROTECTED_BASENAMES.has(basename)) {
      issues.push({ path, severity: 'error', message: 'Generated file would overwrite a dependency lockfile.' });
    }

    // Content presence.
    if (!content.trim()) {
      issues.push({ path, severity: 'error', message: 'File content is empty.' });
      continue;
    }
    if (content.includes(TRUNCATION_MARKER)) {
      issues.push({ path, severity: 'error', message: 'File content appears truncated (contains a truncation marker).' });
    }

    // Lossy-regeneration check — when an agent modifies an EXISTING file, its
    // output should not be a shrunken copy of the original. The failure mode this
    // catches (and how it shipped a broken README before): the model echoes the
    // file it was shown and trails off partway through, emitting syntactically
    // valid output that is really the original truncated mid-document. Markdown
    // and other non-code files get no syntax check, so this is their only guard.
    const original = originals[path] ?? originals[normalized];
    if (original != null) {
      const o = original.trimEnd();
      const n = content.trimEnd();
      // Exact prefix of the original but shorter → an echo that stopped early.
      if (n.length < o.length && o.startsWith(n)) {
        issues.push({
          path,
          severity: 'error',
          message: `Modified file is a truncated copy of the original (${n.length}/${o.length} chars, exact prefix) — the agent echoed the existing file and stopped early.`,
        });
      } else if (o.length >= 400 && n.length < o.length * 0.5) {
        // Not a prefix, but lost more than half its content — likely lossy.
        issues.push({
          path,
          severity: 'error',
          message: `Modified file is ${Math.round((1 - n.length / o.length) * 100)}% shorter than the original (${n.length}/${o.length} chars) — likely truncated or lossy regeneration.`,
        });
      }
    }

    // Type-specific syntax checks.
    const ext = extname(basename);
    if (ext === '.json') {
      try {
        JSON.parse(content);
      } catch (err) {
        issues.push({ path, severity: 'error', message: `Invalid JSON: ${err instanceof Error ? err.message : 'parse failed'}` });
      }
    } else if (TS_LIKE_EXTENSIONS.has(ext)) {
      issues.push(...checkSyntax(path, content, ext));
      if (canCheckImports) {
        issues.push(...checkImports(path, normalized, content, knownPaths));
      }
    }
  }

  const ok = !issues.some((issue) => issue.severity === 'error');
  return { ok, issues, filesChecked: changes.length };
}

/**
 * Single-file syntax check via the TypeScript transpiler. `transpileModule` parses
 * and emits without resolving imports, so it surfaces real syntax errors without
 * the "cannot find module" noise a full typecheck against an absent repo would give.
 */
function checkSyntax(path: string, content: string, ext: string): ValidationIssue[] {
  const isJsx = ext === '.tsx' || ext === '.jsx';
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    isolatedModules: false,
    noResolve: true,
  };
  // Only set `jsx` for JSX files — passing the key with an undefined value makes
  // the transpiler emit a spurious "--jsx option must be..." diagnostic on every
  // plain .ts/.js file.
  if (isJsx) {
    compilerOptions.jsx = ts.JsxEmit.Preserve;
  }

  const output = ts.transpileModule(content, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions,
  });

  return (output.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .slice(0, MAX_SYNTAX_ISSUES_PER_FILE)
    .map((d) => ({
      path,
      severity: 'error' as const,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
    }));
}

/** Human/LLM-readable summary of static results, for the DevOps prompt and logs. */
export function formatStaticResults(result: StaticValidationResult): string {
  if (result.filesChecked === 0) {
    return 'No code files were generated, so there was nothing to statically validate.';
  }
  if (result.ok) {
    return `All ${result.filesChecked} generated file(s) passed static checks (syntax, JSON validity, content presence, path safety).`;
  }
  const errors = result.issues.filter((i) => i.severity === 'error');
  const lines = errors.map((i) => `- ${i.path}: ${i.message}`).join('\n');
  return `Static validation found ${errors.length} error(s) across ${result.filesChecked} generated file(s):\n${lines}`;
}
