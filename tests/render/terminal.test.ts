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

test('"Agent said done, but" section renders first with each contradiction', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    claimedDone: {
      source: 'claude',
      message: 'All tests pass, done.',
      at: '2026-10-20T18:25:00.000Z',
      contradictions: ['SMTP connection refused (still failing)', '1 uncommitted file'],
    },
  };
  const lines = renderTerminal(f, null, { color: false, now: RAHUL_NOW }).split('\n');
  const first = lines.findIndex((l) => /^[A-Z]/.test(l) && !l.startsWith('Where'));
  expect(lines.slice(first, first + 4)).toEqual([
    'Agent said done, but',
    '  claude said: "All tests pass, done." (14h ago)',
    '  ✗ SMTP connection refused (still failing)',
    '  ✗ 1 uncommitted file',
  ]);
  expect(lines.indexOf('Agent said done, but')).toBeLessThan(lines.indexOf('Done'));
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
  expect(out).toContain('  → Resolve: SMTP connection refused');
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
