import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseProgram } from './cmd.js';

/**
 * The skill's Python preflight mirrors this parser; both must agree on the shared corpus
 * (skill/parity-corpus.jsonl). The TS side is authoritative — this test pins it to the corpus.
 */
interface Row {
  id: string;
  program: string;
  ok: boolean;
  kinds: string[];
  reads: number;
  errors: number;
  done: boolean;
}

const rows: Row[] = readFileSync(
  new URL('../../../skill/parity-corpus.jsonl', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

describe('cmd parity corpus', () => {
  it.each(rows.map((r) => [r.id, r] as const))('%s', (_id, row) => {
    const r = parseProgram(row.program);
    if ('fenceError' in r) {
      expect(row.ok).toBe(false);
      return;
    }
    const kinds = r.lines.flatMap((l) => (l.verb === 'effect' ? [l.effect.kind] : []));
    const reads = r.lines.filter((l) => l.verb === 'read' || l.verb === 'search').length;
    expect(r.errors.length).toBe(row.errors);
    if (row.ok) expect(kinds).toEqual(row.kinds);
    expect(reads).toBe(row.reads);
    expect(r.done).toBe(row.done);
  });
});
