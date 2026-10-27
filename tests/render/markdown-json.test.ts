import { expect, test } from 'vitest';
import { renderJson } from '../../src/render/json.ts';
import { renderMarkdown } from '../../src/render/markdown.ts';
import { RAHUL_NOW, rahulFacts } from './helpers.ts';

test('json render is valid JSON with facts and polished', () => {
  const f = rahulFacts();
  const parsed = JSON.parse(renderJson(f, 'Short summary.'));
  expect(parsed).toEqual({ facts: f, polished: 'Short summary.' });
  expect(JSON.parse(renderJson(f, null)).polished).toBeNull();
});

test('markdown render has the same sections as the terminal, as headings and lists', () => {
  const out = renderMarkdown(rahulFacts(), null, { now: RAHUL_NOW });
  const lines = out.split('\n');
  expect(lines[0]).toBe('## Where you left off — myapp (feature/forgot-password)');
  expect(out).toContain('_Last active 14h ago_');
  expect(out).toContain(
    '### Done\n\n- Built POST /auth/forgot-password endpoint\n- Added reset-token migration',
  );
  expect(out).toContain(
    '### Unfinished\n\n- `email_service.py` (modified)\n- 1 file changed, 6 insertions(+), 2 deletions(-)',
  );
  expect(out).toContain(
    '### Open problems\n\n- **`python scripts/send_test_email.py` — SMTP connection refused** — tried: changed port to 587 · disabled TLS',
  );
  expect(out).toContain(
    '### Next step\n\n→ Resolve: `python scripts/send_test_email.py` — SMTP connection refused',
  );
  expect(lines.at(-1)).toBe('Sources: claude ✓ · git ✓ · shell ✓ · codex –');
});

test('markdown leaves a problem shown under "Agent said done, but" out of Open problems', () => {
  const smtp = '`python scripts/send_test_email.py` — SMTP connection refused';
  const f = rahulFacts();
  f.claimedDone = {
    source: 'claude',
    message: 'Done.',
    at: '2026-10-20T18:25:00.000Z',
    contradictions: [`${smtp} (still failing)`],
  };
  const out = renderMarkdown(f, null, { now: RAHUL_NOW });
  expect(out).toContain(`- ✗ ${smtp} (still failing) — tried: changed port to 587 · disabled TLS`);
  expect(out).not.toContain('### Open problems');
});
