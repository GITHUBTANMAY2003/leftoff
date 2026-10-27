import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { BriefFacts } from '../../src/brief/facts.ts';
import { renderTerminal } from '../../src/render/terminal.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

const golden = (name: string) => readFileSync(join(import.meta.dirname, 'golden', name), 'utf8');
// eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
const ANSI = /\x1b\[[0-9;]*m/;

test('terminal render matches golden for rahul scenario', () => {
  expect(renderTerminal(rahulFacts(), null, { color: false, now: RAHUL_NOW }) + '\n').toBe(
    golden('rahul.txt'),
  );
});

test('empty sections are omitted', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    done: [],
    openProblems: [],
    unfinished: { files: [], diffStat: null },
  };
  const out = renderTerminal(f, null, { color: false, now: RAHUL_NOW });
  expect(out).not.toMatch(/^(Done|Unfinished|Open problems|Notes|Agent said done, but)$/m);
  expect(out).toMatch(/^Next step$/m);
});

const SMTP = '`python scripts/send_test_email.py` — SMTP connection refused';
const claimed = (contradictions: string[]): BriefFacts => ({
  ...rahulFacts(),
  claimedDone: {
    source: 'claude',
    message: 'All tests pass, done.',
    at: '2026-10-20T18:25:00.000Z',
    contradictions,
  },
});

test('"Agent said done, but" section renders first with each contradiction', () => {
  const f = claimed([`${SMTP} (still failing)`, '1 uncommitted file']);
  const lines = renderTerminal(f, null, { color: false, now: RAHUL_NOW }).split('\n');
  const first = lines.findIndex((l) => /^[A-Z]/.test(l) && !l.startsWith('Where'));
  expect(lines.slice(first, first + 5)).toEqual([
    'Agent said done, but',
    '  claude said: "All tests pass, done." (14h ago)',
    `  ✗ ${SMTP} (still failing)`,
    '    tried: changed port to 587 · disabled TLS',
    '  ✗ 1 uncommitted file',
  ]);
  expect(lines.indexOf('Agent said done, but')).toBeLessThan(lines.indexOf('Done'));
});

test('a problem shown under "Agent said done, but" is left out of Open problems', () => {
  const out = renderTerminal(claimed([`${SMTP} (still failing)`]), null, {
    color: false,
    now: RAHUL_NOW,
  });
  expect(out).not.toMatch(/^Open problems$/m);
  expect(out.split(SMTP)).toHaveLength(3); // the contradiction and the next step, nothing else
});

test('other open problems stay under Open problems', () => {
  const f = claimed([`${SMTP} (still failing)`]);
  f.openProblems = [
    ...f.openProblems,
    {
      error: 'disk full',
      command: null,
      isTest: false,
      source: 'shell',
      firstSeen: f.window.from,
      attempts: [],
    },
  ];
  const lines = renderTerminal(f, null, { color: false, now: RAHUL_NOW }).split('\n');
  const at = lines.indexOf('Open problems');
  expect(lines.slice(at, at + 3)).toEqual(['Open problems', '  ✗ disk full', '']);
});

test('lines longer than 100 characters are cut with "…" in the terminal', () => {
  const long = `npm error ${'x'.repeat(200)}`;
  const f: BriefFacts = {
    ...rahulFacts(),
    openProblems: [
      {
        error: long,
        command: 'npm run lint',
        isTest: false,
        source: 'claude',
        firstSeen: '',
        attempts: [long],
      },
    ],
    notes: ['🙂'.repeat(150)],
  };
  const plain = renderTerminal(f, null, { color: false, now: RAHUL_NOW });
  const lines = plain.split('\n');
  for (const l of lines) expect([...l].length).toBeLessThanOrEqual(100);
  const problem = lines.find((l) => l.startsWith('  ✗ `npm run lint` — npm error x'));
  expect([...(problem as string)]).toHaveLength(100);
  expect(problem?.endsWith('x…')).toBe(true);
  expect(lines.find((l) => l.startsWith('    tried: '))?.endsWith('…')).toBe(true);
  expect(lines.find((l) => l.startsWith('  • 🙂'))).toBe(`  • ${'🙂'.repeat(95)}…`);
  const colored = renderTerminal(f, null, { color: true, now: RAHUL_NOW });
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain);
});

test('Notes render after Open problems and before Next step', () => {
  const f: BriefFacts = { ...rahulFacts(), notes: ['ask ops about the relay'] };
  const lines = renderTerminal(f, null, { color: false, now: RAHUL_NOW }).split('\n');
  const at = (h: string) => lines.indexOf(h);
  expect(at('Open problems')).toBeLessThan(at('Notes'));
  expect(at('Notes')).toBeLessThan(at('Next step'));
  expect(lines[at('Notes') + 1]).toBe('  • ask ops about the relay');
});

test('Sources line uses the fixed order claude, git, shell, codex; no footer after it', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    sources: [
      { name: 'claude', status: 'error', detail: 'timeout' },
      { name: 'git', status: 'ok' },
      { name: 'shell', status: 'not_found' },
      { name: 'codex', status: 'ok' },
    ],
  };
  const out = renderTerminal(f, null, { color: false, now: RAHUL_NOW });
  expect(out.split('\n').at(-1)).toBe('Sources: claude !  git ✓  shell –  codex ✓');
});

test('a polished paragraph is shown above the facts, which are still all shown', () => {
  const out = renderTerminal(
    rahulFacts(),
    'Rahul was wiring up password resets; SMTP still refuses.',
    {
      color: false,
      now: RAHUL_NOW,
    },
  );
  const lines = out.split('\n');
  expect(lines[2]).toBe('Rahul was wiring up password resets; SMTP still refuses.');
  expect(out).toContain(
    '  → Resolve: `python scripts/send_test_email.py` — SMTP connection refused',
  );
  expect(out).toContain('Done');
});

test('header without a branch, and with no activity yet', () => {
  const f: BriefFacts = { ...rahulFacts(), branch: null };
  expect(renderTerminal(f, null, { color: false, now: RAHUL_NOW }).split('\n')[0]).toBe(
    'Where you left off — myapp · last active 14h ago',
  );
  const none: BriefFacts = { ...f, lastActiveAt: null };
  expect(renderTerminal(none, null, { color: false, now: RAHUL_NOW }).split('\n')[0]).toBe(
    'Where you left off — myapp · no activity recorded yet',
  );
});

test('NO_COLOR disables ANSI', () => {
  expect(renderTerminal(rahulFacts(), null, { color: true, now: RAHUL_NOW })).toMatch(ANSI);
  expect(renderTerminal(rahulFacts(), null, { color: false, now: RAHUL_NOW })).not.toMatch(ANSI);
});

test('with color, the text is the same once the ANSI codes are removed', () => {
  const plain = renderTerminal(rahulFacts(), null, { color: false, now: RAHUL_NOW });
  const colored = renderTerminal(rahulFacts(), null, { color: true, now: RAHUL_NOW });
  // eslint-disable-next-line no-control-regex -- matching ANSI color codes is the point
  expect(colored.replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain);
});
