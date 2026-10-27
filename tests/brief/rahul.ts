// The §1.1 scenario as events: Rahul builds "forgot password" with Claude Code
// on Tuesday evening, hits "SMTP connection refused", the agent tries two fixes
// that fail, and he logs off with email_service.py uncommitted. Used by the
// brief tests (Task 9), the renderers (Tasks 10–11) and e2e (Task 16).
import type { WorkingState } from '../../src/collectors/git.ts';
import type { IngestReport } from '../../src/ingest/ingest.ts';
import { makeEvent, type EventKind, type Source, type WorkEvent } from '../../src/model/event.ts';

export const RAHUL_ROOT = '/home/rahul/myapp';
export const RAHUL_SESSION = 'claude-session-tuesday';
// Wednesday 08:30 local; the last activity is Tuesday 18:30 (14 h earlier).
export const RAHUL_NOW = new Date('2026-10-21T08:30:00.000Z');

const SEND = 'python scripts/send_test_email.py';

let seq = 0;
let root = RAHUL_ROOT;
function ev(
  source: Source,
  kind: EventKind,
  ts: string,
  summary: string,
  data: Record<string, unknown> = {},
): WorkEvent {
  return makeEvent({
    source,
    kind,
    projectRoot: root,
    ts,
    sessionRef: source === 'claude' ? RAHUL_SESSION : null,
    summary,
    data,
    dedupeKey: `rahul-${seq++}`,
  });
}

// `projectRoot` lets a test place the scenario in a real (temporary) folder.
export function rahulEvents(projectRoot = RAHUL_ROOT): WorkEvent[] {
  seq = 0;
  root = projectRoot;
  return [
    ev(
      'claude',
      'user_prompt',
      '2026-10-20T17:00:00.000Z',
      'Add a forgot-password flow: endpoint, reset token, email',
    ),
    ev('git', 'commit', '2026-10-20T17:20:00.000Z', 'Built POST /auth/forgot-password endpoint', {
      hash: 'f00d001',
    }),
    ev('git', 'commit', '2026-10-20T17:35:00.000Z', 'Added reset-token migration', {
      hash: 'a1b2c3d',
    }),
    ev(
      'claude',
      'command_failed',
      '2026-10-20T17:50:00.000Z',
      `\`${SEND}\` failed: SMTP connection refused`,
      {
        command: SEND,
        exitCode: 1,
        error: 'SMTP connection refused\n  File "email_service.py", line 12',
      },
    ),
    ev('claude', 'command', '2026-10-20T18:00:00.000Z', 'changed port to 587', {
      command: "sed -i 's/25/587/' config.py",
      exitCode: 0,
    }),
    ev(
      'claude',
      'command_failed',
      '2026-10-20T18:05:00.000Z',
      `\`${SEND}\` failed: SMTP connection refused`,
      {
        command: SEND,
        exitCode: 1,
        error: 'SMTP connection refused',
      },
    ),
    ev('claude', 'command', '2026-10-20T18:15:00.000Z', 'disabled TLS', {
      command: "sed -i 's/use_tls=True/use_tls=False/' config.py",
      exitCode: 0,
    }),
    ev(
      'claude',
      'command_failed',
      '2026-10-20T18:20:00.000Z',
      `\`${SEND}\` failed: SMTP connection refused`,
      {
        command: SEND,
        exitCode: 1,
        error: 'SMTP connection refused',
      },
    ),
    ev(
      'claude',
      'agent_message',
      '2026-10-20T18:30:00.000Z',
      'The SMTP server still refuses the connection on both ports.',
    ),
  ];
}

export const RAHUL_WORKING: WorkingState = {
  branch: 'feature/forgot-password',
  files: [{ path: 'email_service.py', status: 'modified' }],
  diffStat: '1 file changed, 6 insertions(+), 2 deletions(-)',
};

export const RAHUL_REPORT: IngestReport = {
  perSource: {
    claude: { status: 'ok', inserted: 0, warnings: [] },
    codex: { status: 'not_found', inserted: 0, warnings: [] },
    shell: { status: 'ok', inserted: 0, warnings: [] },
    git: { status: 'ok', inserted: 0, warnings: [] },
  },
  prunedEvents: 0,
};
