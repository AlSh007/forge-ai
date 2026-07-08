import { validateChanges } from './static';
import { CodeChange } from '../types';

const ok = (changes: CodeChange[]) => validateChanges(changes).ok;

describe('validateChanges', () => {
  it('accepts valid TypeScript', () => {
    expect(ok([{ path: 'src/a.ts', content: 'export const x: number = 1;\nfunction f(){ return x + 1; }' }])).toBe(true);
  });

  it('accepts valid JavaScript', () => {
    expect(ok([{ path: 'src/a.js', content: 'const x = 1; module.exports = { x };' }])).toBe(true);
  });

  it('rejects broken TypeScript syntax', () => {
    expect(ok([{ path: 'src/b.ts', content: 'export const x = ;\nfunction (' }])).toBe(false);
  });

  it('accepts valid TSX', () => {
    expect(ok([{ path: 'src/C.tsx', content: 'export const C = () => <div className="a">hi {1 + 1}</div>;' }])).toBe(true);
  });

  it('rejects broken TSX (mismatched tags)', () => {
    expect(ok([{ path: 'src/D.tsx', content: 'export const C = () => <div>oops</span>;' }])).toBe(false);
  });

  it('accepts valid JSON', () => {
    expect(ok([{ path: 'cfg.json', content: '{"a":1,"b":[2,3]}' }])).toBe(true);
  });

  it('rejects invalid JSON', () => {
    expect(ok([{ path: 'cfg.json', content: '{a:1, b: }' }])).toBe(false);
  });

  it('rejects empty content', () => {
    expect(ok([{ path: 'src/e.ts', content: '   ' }])).toBe(false);
  });

  it('rejects truncated content', () => {
    expect(ok([{ path: 'src/f.ts', content: 'const a = 1;\n... [truncated]' }])).toBe(false);
  });

  it('rejects a path that escapes the repository root', () => {
    expect(ok([{ path: '../../../etc/passwd', content: 'x' }])).toBe(false);
  });

  it('rejects overwriting a dependency lockfile', () => {
    expect(ok([{ path: 'package-lock.json', content: '{}' }])).toBe(false);
  });

  it('rejects a missing path', () => {
    expect(ok([{ path: '', content: 'x' }])).toBe(false);
  });

  it('treats zero changes as passing', () => {
    expect(ok([])).toBe(true);
  });

  it('passes through file types it does not parse (SQL)', () => {
    expect(ok([{ path: 'migrations/001.sql', content: 'CREATE TABLE t (id int);' }])).toBe(true);
  });

  // Regression: a plain .ts file was once flagged with a spurious "--jsx" diagnostic.
  it('does not flag a plain .ts file with a spurious --jsx diagnostic', () => {
    const result = validateChanges([{ path: 'src/plain.ts', content: 'export const n: number = 42;' }]);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('reports issues with path and severity', () => {
    const result = validateChanges([{ path: 'cfg.json', content: '{bad}' }]);
    expect(result.ok).toBe(false);
    expect(result.issues[0].path).toBe('cfg.json');
    expect(result.issues[0].severity).toBe('error');
  });

  describe('relative import resolution', () => {
    const tree = ['src/index.ts', 'src/services/user.ts', 'src/utils/index.ts', 'components/Card.tsx'];

    it('rejects a relative import that resolves to no known file', () => {
      const result = validateChanges(
        [{ path: 'src/index.ts', content: 'import { getUser } from "./services/missing";\nexport const x = getUser;' }],
        {},
        tree
      );
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.message.includes('dangling import'))).toBe(true);
    });

    it('accepts a relative import to an existing repo file (extensionless)', () => {
      expect(
        validateChanges(
          [{ path: 'src/index.ts', content: 'import { u } from "./services/user";\nexport const x = u;' }],
          {},
          tree
        ).ok
      ).toBe(true);
    });

    it('accepts a relative import to a sibling file generated in the same run', () => {
      expect(
        validateChanges(
          [
            { path: 'src/a.ts', content: 'import { b } from "./b";\nexport const a = b;' },
            { path: 'src/b.ts', content: 'export const b = 1;' },
          ],
          {},
          tree
        ).ok
      ).toBe(true);
    });

    it('resolves a directory import to its index file', () => {
      expect(
        validateChanges(
          [{ path: 'src/index.ts', content: 'import { helper } from "./utils";\nexport const x = helper;' }],
          {},
          tree
        ).ok
      ).toBe(true);
    });

    it('rewrites an ESM .js specifier to a .ts source', () => {
      expect(
        validateChanges(
          [{ path: 'src/index.ts', content: 'import { u } from "./services/user.js";\nexport const x = u;' }],
          {},
          tree
        ).ok
      ).toBe(true);
    });

    it('does not flag bare or aliased imports', () => {
      const result = validateChanges(
        [{ path: 'src/index.ts', content: 'import express from "express";\nimport { c } from "@/components/Card";\nexport const x = { express, c };' }],
        {},
        tree
      );
      expect(result.ok).toBe(true);
    });

    it('skips import checks entirely when no repo tree is provided', () => {
      // Without a tree we cannot distinguish "missing" from "unknown" — fail open.
      expect(
        validateChanges([{ path: 'src/index.ts', content: 'import { z } from "./nowhere";\nexport const x = z;' }]).ok
      ).toBe(true);
    });
  });

  it('validates multiple files together and counts them', () => {
    const result = validateChanges([
      { path: 'src/api/users.ts', content: 'import express from "express";\nexport const r = express.Router();' },
      { path: 'prisma/migrations/add.sql', content: 'ALTER TABLE users ADD COLUMN age int;' },
      { path: 'components/Card.tsx', content: 'export function Card({ t }: { t: string }) { return <div>{t}</div>; }' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.filesChecked).toBe(3);
  });
});
