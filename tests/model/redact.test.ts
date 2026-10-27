import { expect, test } from 'vitest';
import { redact, redactDeep } from '../../src/model/redact.ts';

test.each([
  ['export GITHUB_TOKEN=ghp_' + 'a'.repeat(36), 'export GITHUB_TOKEN=[REDACTED]'],
  ['curl -H "Authorization: Bearer abc.def.ghi"', 'curl -H "Authorization: Bearer [REDACTED]"'],
  ['psql postgres://admin:hunter2@db:5432/x', 'psql postgres://admin:[REDACTED]@db:5432/x'],
  ['mysql --password hunter2 -u root', 'mysql --password [REDACTED] -u root'],
  [
    'ANTHROPIC_API_KEY=sk-ant-' + 'x'.repeat(30) + ' npm start',
    'ANTHROPIC_API_KEY=[REDACTED] npm start',
  ],
])('redacts %s', (input, expected) => expect(redact(input)).toBe(expected));

test.each([
  ['aws key', 'aws configure set key AKIAABCDEFGHIJKLMNOP', 'aws configure set key [REDACTED]'],
  ['github token', 'echo gho_' + 'b'.repeat(40), 'echo [REDACTED]'],
  [
    'github fine-grained pat',
    'gh auth login github_pat_' + 'c'.repeat(30),
    'gh auth login [REDACTED]',
  ],
  ['openai-style key', 'curl -d key=x sk-' + 'd'.repeat(24), 'curl -d key=x [REDACTED]'],
  ['slack token', 'post xoxb-1234567890-abcdef', 'post [REDACTED]'],
  ['jwt', 'token is eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM here', 'token is [REDACTED] here'],
  ['--token=value', 'deploy --token=abc123 --env prod', 'deploy --token=[REDACTED] --env prod'],
  [
    'json password',
    '{"user": "bob", "password": "hunter2"}',
    '{"user": "bob", "password": "[REDACTED]"}',
  ],
  ['env name containing PASSWORD', 'PGPASSWORD=hunter2 psql', 'PGPASSWORD=[REDACTED] psql'],
  ['auth as a name segment', 'GH_AUTH=abc123 gh pr list', 'GH_AUTH=[REDACTED] gh pr list'],
  ['secret in a quoted value', "CLIENT_SECRET='a b c' ./run", 'CLIENT_SECRET=[REDACTED] ./run'],
])('redacts %s', (_name, input, expected) => expect(redact(input)).toBe(expected));

test('redacts a PEM private key block, keeping the markers', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----';
  expect(redact(`key:\n${pem}\ndone`)).toBe(
    'key:\n-----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY-----\ndone',
  );
});

test('redact leaves ordinary commands alone', () =>
  expect(redact('git commit -m "fix token parsing"')).toBe('git commit -m "fix token parsing"'));

test.each([
  'risk-assessment-for-the-quarter', // R-D6: no word boundary before "sk-"
  'git commit --author="Tanmay Kumar" -m wip', // "auth" only as a name segment
  'npm install passport-local',
  'ssh deploy@example.com',
  'https://example.com/a/b?page=2',
])('redact leaves %j unchanged', (input) => expect(redact(input)).toBe(input));

// Regression (found by the git collector, Task 5): a "-name" inside a word is
// not a flag. These are the §1.1 scenario's own branch and commit.
test.each([
  'git commit -m "Added reset-token migration"',
  'Added reset-token migration', // a commit subject, as the git collector stores it
  'git checkout feature/forgot-password',
  'Switched from feature/forgot-password to main',
  'npm run reset-password -- --dry-run',
])('a -name inside a word is not a flag: %j is unchanged', (input) =>
  expect(redact(input)).toBe(input),
);

test.each([
  ['-password hunter2 at the start', '-password [REDACTED] at the start'],
  ['tool\t--token abc', 'tool\t--token [REDACTED]'],
])('a flag at the start or after whitespace is still redacted: %j', (input, expected) =>
  expect(redact(input)).toBe(expected),
);

test('"Authorization: Bearer x" is handled by the Bearer rule, not the auth-assignment rule', () => {
  // R-D6: the header name must stay, only the token goes.
  expect(redact('Authorization: Bearer x1y2z3')).toBe('Authorization: Bearer [REDACTED]');
});

test.each([
  ['mysql -u root -phunter2 shop', 'mysql -u root -p[REDACTED] shop'],
  ['mariadb -h db -pS3cr3t!', 'mariadb -h db -p[REDACTED]'],
  ['mysqldump -uroot -pabc123 shop > dump.sql', 'mysqldump -uroot -p[REDACTED] shop > dump.sql'],
  ['sshpass -p hunter2 ssh deploy@host', 'sshpass -p [REDACTED] ssh deploy@host'],
  ['sshpass -phunter2 scp a host:', 'sshpass -p[REDACTED] scp a host:'],
])('redacts a glued or -p password: %s', (input, expected) => expect(redact(input)).toBe(expected));

test.each([
  'mysql -h db -P 3306 -u root -p shop', // -p alone prompts; -P is the port
  'ssh -p 2222 deploy@host',
  'docker run -p 3306:3306 mysql:8',
  'mkdir -p build/out',
  'git log -p -1',
  'cd mysql-data && ls -p',
  'pg_dump -p5432 shop', // glued -p is a port here
  'tar -pxf backup.tar',
])('-p in other commands is untouched: %j', (input) => expect(redact(input)).toBe(input));

test('redact is idempotent', () => {
  const once = redact('ANTHROPIC_API_KEY=sk-ant-' + 'x'.repeat(30) + ' curl -H "Bearer abc"');
  expect(redact(once)).toBe(once);
});

test('redactDeep walks nested objects and arrays', () => {
  const input = {
    command: 'export GITHUB_TOKEN=ghp_' + 'a'.repeat(36),
    nested: { list: ['psql postgres://admin:hunter2@db/x', 3, true, null] },
  };
  expect(redactDeep(input)).toEqual({
    command: 'export GITHUB_TOKEN=[REDACTED]',
    nested: { list: ['psql postgres://admin:[REDACTED]@db/x', 3, true, null] },
  });
});

test('redactDeep redacts string values whose key is a secret name', () => {
  expect(redactDeep({ password: 'hunter2', apiKey: 'plain', user: 'bob', tokens: 5 })).toEqual({
    password: '[REDACTED]',
    apiKey: '[REDACTED]',
    user: 'bob',
    tokens: 5,
  });
});

test('redactDeep does not mutate its input', () => {
  const input = { a: { b: 'GH_TOKEN=abc' } };
  redactDeep(input);
  expect(input).toEqual({ a: { b: 'GH_TOKEN=abc' } });
});

// Regression (found by the soft-deadline tests, Task 9): rules that can start
// matching at every character of a long word were quadratic.
test.each([
  ['one long word', 'x'.repeat(100_000)],
  ['long words with dashes and dots', 'a.b-c_d'.repeat(15_000)],
  ['long prose', 'the quick brown fox jumps over the lazy dog '.repeat(2500)],
])('redact is fast on %s (100 KB in < 50 ms)', (_name, text) => {
  const started = performance.now();
  expect(redact(text)).toBe(text);
  expect(performance.now() - started).toBeLessThan(50);
});
