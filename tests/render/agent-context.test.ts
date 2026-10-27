import { expect, test } from 'vitest';
import type { BriefFacts } from '../../src/brief/facts.ts';
import { renderAgentContext } from '../../src/render/markdown.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

const FIRST = '## Previous session in this project (from leftoff)';
const LAST =
  'This is an automatic summary of earlier work. Verify against the code before relying on it.';

test('agent context starts and ends with exact lines and is ≤ 4000 chars even with 200 files', () => {
  const f: BriefFacts = {
    ...rahulFacts(),
    unfinished: {
      files: Array.from({ length: 200 }, (_, i) => ({
        path: `src/module-${i}/file-${i}.ts`,
        status: 'modified',
      })),
      diffStat: '200 files changed',
    },
  };
  const out = renderAgentContext(f, 'Polished summary that must survive truncation.', {
    now: RAHUL_NOW,
  });
  const lines = out.split('\n');
  expect(lines[0]).toBe(FIRST);
  expect(lines.at(-1)).toBe(LAST);
  expect(out.length).toBeLessThanOrEqual(4000);
  expect(out).toContain('Polished summary that must survive truncation.'); // prose kept, lists cut
  expect(out).toMatch(/and \d+ more/);
  expect(out).toContain('src/module-0/file-0.ts'); // shortened, not dropped
  expect(out).toContain('Suggested next step: Resolve: SMTP connection refused');
});

test('the agent is told what was already tried, so it does not retry it (§1.1)', () => {
  const out = renderAgentContext(rahulFacts(), null, { now: RAHUL_NOW });
  expect(out).toContain('SMTP connection refused');
  expect(out).toContain('Already tried (did not fix it): changed port to 587; disabled TLS');
  expect(out).toContain('feature/forgot-password');
  expect(out).toContain('email_service.py');
  expect(out).toContain('Suggested next step: Resolve: SMTP connection refused');
});

test('a huge single text field is still cut to fit, keeping the first and last lines', () => {
  const f: BriefFacts = { ...rahulFacts(), lastIntent: 'x'.repeat(10_000) };
  const out = renderAgentContext(f, 'y'.repeat(10_000), { now: RAHUL_NOW });
  expect(out.length).toBeLessThanOrEqual(4000);
  expect(out.startsWith(FIRST)).toBe(true);
  expect(out.endsWith(LAST)).toBe(true);
});

test('the 4000 limit holds for emoji-heavy text (UTF-16 length) without splitting an emoji', () => {
  const f: BriefFacts = { ...rahulFacts(), lastIntent: '😀'.repeat(5000) };
  const out = renderAgentContext(f, null, { now: RAHUL_NOW });
  expect(out.length).toBeLessThanOrEqual(4000);
  expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
});
