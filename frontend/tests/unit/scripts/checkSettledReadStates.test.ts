/**
 * The frontend settled-read-state ratchet (`scripts/check-settled-read-states.mjs`,
 * ADR 0010) shipped without tests of its own; the backend half got them and
 * this one did not. A gate with no failing test is a report with a green tick,
 * so these run the real script as a child process against fixture trees and
 * check both directions of the ratchet, for both shapes it detects.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../../../scripts/check-settled-read-states.mjs');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(files: Record<string, string>, accepted: Record<string, string> = {}): RunResult {
  const root = mkdtempSync(join(tmpdir(), 'reads-ratchet-fe-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const abs = join(src, name);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  const baseline = join(root, 'baseline.json');
  writeFileSync(baseline, JSON.stringify({ accepted }));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--src', src, '--baseline', baseline], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const PREAMBLE = `
import { useQuery } from '@tanstack/react-query';
import { spaceService } from '@/services/spaceService';
`;

describe('settled-read-state ratchet (frontend) — the silent-guard shape', () => {
  it('catches `const { data } = useQuery(...)` plus `if (!data) return null`', () => {
    const out = run({
      'features/Card.tsx': `${PREAMBLE}
export function Card() {
  const { data } = useQuery({ queryKey: ['x'], queryFn: spaceService.getSpaces });
  if (!data) return null;
  return <p>{data.length}</p>;
}`,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('features/Card.tsx::data::silent-guard');
  });

  it('does not flag a component that binds an outcome field', () => {
    const out = run({
      'features/Card.tsx': `${PREAMBLE}
export function Card() {
  const { data, isError } = useQuery({ queryKey: ['x'], queryFn: spaceService.getSpaces });
  if (isError) return <p>unavailable</p>;
  if (!data) return null;
  return <p>{data.length}</p>;
}`,
    });
    expect(out.code).toBe(0);
  });
});

/**
 * #456 / #457's "third, smaller one": the declaration-site coalescing form.
 * ADR 0010 named `?? []` as out of scope because it needs type information;
 * `data: x = []` needs none, and it is the harder of the two to see.
 */
describe('settled-read-state ratchet (frontend) — the default-literal shape', () => {
  it('catches `const { data: spaces = [] } = useQuery(...)`', () => {
    const out = run({
      'features/PlantsPage.tsx': `${PREAMBLE}
export function PlantsPage() {
  const { data: spaces = [] } = useQuery({ queryKey: ['spaces'], queryFn: spaceService.getSpaces });
  return <p>{spaces.length}</p>;
}`,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('features/PlantsPage.tsx::spaces::default-literal');
    expect(out.stderr).toContain('data: spaces = []');
  });

  it('catches a zero default too, not only an empty array', () => {
    const out = run({
      'features/Counter.tsx': `${PREAMBLE}
export function Counter() {
  const { data: used = 0 } = useQuery({ queryKey: ['usage'], queryFn: spaceService.getSpaces });
  return <p>{used}</p>;
}`,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('features/Counter.tsx::used::default-literal');
  });

  it('does not flag a defaulted destructure that also binds the outcome', () => {
    // PlantsPage's adjacent tasks query is written this way and is correct:
    // the default is a convenience, and the failure is rendered from isError.
    const out = run({
      'features/PlantsPage.tsx': `${PREAMBLE}
export function PlantsPage() {
  const { data: tasks = [], isError } = useQuery({ queryKey: ['t'], queryFn: spaceService.getSpaces });
  return <p>{isError ? 'unavailable' : tasks.length}</p>;
}`,
    });
    expect(out.code).toBe(0);
  });

  it('does not flag a NON-literal default — that one has a name attached', () => {
    const out = run({
      'features/PlantsPage.tsx': `${PREAMBLE}
export function PlantsPage({ fallbackSpaces }: { fallbackSpaces: string[] }) {
  const { data: spaces = fallbackSpaces } = useQuery({ queryKey: ['s'], queryFn: spaceService.getSpaces });
  return <p>{spaces.length}</p>;
}`,
    });
    expect(out.code).toBe(0);
  });

  it('accepts a baselined occurrence and reports it in the count', () => {
    const out = run(
      {
        'features/AddPlant.tsx': `${PREAMBLE}
export function AddPlant() {
  const { data: templates = [] } = useQuery({ queryKey: ['tpl'], queryFn: spaceService.getSpaces });
  return <p>{templates.length}</p>;
}`,
      },
      {
        'features/AddPlant.tsx::templates::default-literal': 'a suggestion, asserts nothing',
      }
    );
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('1 accepted occurrences (baseline 1, ratchet-only)');
  });

  it('fails on a baseline entry that no longer matches anything', () => {
    const out = run(
      { 'features/Fine.tsx': `${PREAMBLE}\nexport const x = 1;\n` },
      { 'features/AddPlant.tsx::templates::default-literal': 'fixed, entry left behind' }
    );
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('no longer match anything');
  });
});
