import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../../src/core/config.ts';
import { anthropicProvider } from '../../src/polish/providers/anthropic.ts';
import { claudeCli } from '../../src/polish/providers/claude-cli.ts';
import { codexCli } from '../../src/polish/providers/codex-cli.ts';
import { ollamaProvider } from '../../src/polish/providers/ollama.ts';
import { openaiProvider } from '../../src/polish/providers/openai.ts';

let tmp: string;
let bin: string;
let out: string;
const KEYS = ['LEFTOFF_HOME', 'PATH', 'FAKE_OUT', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'leftoff-providers-')));
  bin = join(tmp, 'bin');
  out = join(tmp, 'out');
  mkdirSync(bin);
  mkdirSync(out);
  process.env.LEFTOFF_HOME = join(tmp, 'lhome');
  process.env.FAKE_OUT = out;
  process.env.PATH = `${bin}:/usr/bin:/bin`; // only the fake CLIs, never the real ones
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

// A fake CLI that records its arguments (one per line), cwd, LEFTOFF_INTERNAL
// and stdin under $FAKE_OUT, then runs `body`.
function fakeCli(name: string, body: string): void {
  const file = join(bin, name);
  writeFileSync(
    file,
    `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_OUT/args"
pwd > "$FAKE_OUT/cwd"
printf '%s' "$LEFTOFF_INTERNAL" > "$FAKE_OUT/env"
cat > "$FAKE_OUT/stdin"
${body}
`,
  );
  chmodSync(file, 0o755);
}
const recorded = (what: string) => readFileSync(join(out, what), 'utf8');
const args = () => recorded('args').split('\n').slice(0, -1);

const config = (polish: Partial<Config['polish']> = {}): Config => {
  const c = structuredClone(DEFAULT_CONFIG) as Config;
  c.polish = { ...c.polish, ...polish };
  return c;
};

test('claude-cli provider spawns with LEFTOFF_INTERNAL=1 and cwd in LEFTOFF_HOME/tmp', async () => {
  fakeCli('claude', `echo "  You were fixing SMTP.  "`);
  expect(await claudeCli.available(config())).toBe(true);
  expect(await claudeCli.polish('the prompt', 5000)).toBe('  You were fixing SMTP.  \n');
  expect(recorded('env')).toBe('1');
  expect(recorded('cwd').trim()).toBe(join(tmp, 'lhome', 'tmp'));
  expect(recorded('stdin')).toBe('the prompt');
});

test('claude-cli args include --no-session-persistence and --tools "" and never --bare', async () => {
  fakeCli('claude', 'echo ok');
  await claudeCli.polish('p', 5000);
  expect(args()).toEqual([
    '-p',
    '--no-session-persistence',
    '--tools',
    '',
    '--output-format',
    'text',
  ]);
  expect(args()).not.toContain('--bare');
});

test('codex-cli args include --ephemeral, --skip-git-repo-check and -s read-only', async () => {
  // codex prints progress on stdout; the reply is the file given to -o.
  fakeCli(
    'codex',
    `prev=""; for a in "$@"; do [ "$prev" = "-o" ] && printf 'Codex reply.' > "$a"; prev="$a"; done
echo "progress noise"`,
  );
  expect(await codexCli.polish('the prompt', 5000)).toBe('Codex reply.');
  const a = args();
  expect(a.slice(0, 5)).toEqual([
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '-s',
    'read-only',
  ]);
  expect(a[5]).toBe('-o');
  expect(a.at(-1)).toBe('-');
  expect(recorded('env')).toBe('1');
  expect(recorded('cwd').trim()).toBe(join(tmp, 'lhome', 'tmp'));
  expect(recorded('stdin')).toBe('the prompt');
});

test('a CLI provider that is not on PATH is unavailable', async () => {
  expect(await claudeCli.available(config())).toBe(false);
  expect(await codexCli.available(config())).toBe(false);
});

test('a CLI provider that exits non-zero or runs past the timeout throws', async () => {
  fakeCli('claude', 'echo "not logged in" >&2; exit 3');
  await expect(claudeCli.polish('p', 5000)).rejects.toThrow(/exit code 3.*not logged in/);
  fakeCli('claude', 'sleep 1; touch "$FAKE_OUT/late"');
  const started = Date.now();
  await expect(claudeCli.polish('p', 200)).rejects.toThrow(/timed out/);
  expect(Date.now() - started).toBeLessThan(1000);
  // The process was killed, not left running in the background.
  await new Promise((r) => setTimeout(r, 1500));
  expect(existsSync(join(out, 'late'))).toBe(false);
});

// A local HTTP server standing in for the real API: records the request and
// answers with `reply`.
interface Seen {
  method?: string;
  url?: string;
  headers?: IncomingHttpHeaders;
  body?: unknown;
}
async function server(
  reply: unknown,
  status = 200,
): Promise<{ url: string; seen: Seen; close: () => void }> {
  const seen: Seen = {};
  const s: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => {
      Object.assign(seen, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(data),
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => s.close() };
}

test('ollama posts the prompt to /api/generate with the configured model', async () => {
  const srv = await server({ response: 'Ollama reply.' });
  try {
    const c = config({ ollamaModel: 'qwen3:4b' });
    const p = ollamaProvider(c, srv.url);
    expect(await p.available(c)).toBe(true);
    expect(await p.polish('the prompt', 5000)).toBe('Ollama reply.');
    expect(srv.seen).toMatchObject({
      method: 'POST',
      url: '/api/generate',
      body: { model: 'qwen3:4b', prompt: 'the prompt', stream: false, think: false },
    });
  } finally {
    srv.close();
  }
  expect(await ollamaProvider(config(), 'http://127.0.0.1:1').available(config())).toBe(false);
});

test('ollama strips a <think>…</think> block if a thinking model still sends one', async () => {
  const srv = await server({
    response: '<think>\nThe user wants a summary.\n</think>\n\nYou were fixing the lint script.',
  });
  try {
    const c = config({ ollamaModel: 'qwen3:4b' });
    expect((await ollamaProvider(c, srv.url).polish('p', 5000)).trim()).toBe(
      'You were fixing the lint script.',
    );
  } finally {
    srv.close();
  }
});

test('anthropic sends the key, API version and configured model; reads the text blocks', async () => {
  const srv = await server({
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Anthropic reply.' },
    ],
    stop_reason: 'end_turn',
  });
  try {
    const c = config({ apiModel: 'some-model' });
    const p = anthropicProvider(c, srv.url);
    expect(await p.available(c)).toBe(false); // no key yet
    process.env.ANTHROPIC_API_KEY = 'test-key';
    expect(await p.available(c)).toBe(true);
    expect(await p.polish('the prompt', 5000)).toBe('Anthropic reply.');
    expect(srv.seen.url).toBe('/v1/messages');
    expect(srv.seen.headers?.['x-api-key']).toBe('test-key');
    expect(srv.seen.headers?.['anthropic-version']).toBe('2026-10-21');
    expect(srv.seen.body).toMatchObject({
      model: 'some-model',
      messages: [{ role: 'user', content: 'the prompt' }],
    });
    expect(await anthropicProvider(config(), srv.url).available(config())).toBe(false); // no model
  } finally {
    srv.close();
  }
});

test('openai sends the key and configured model; reads the first choice', async () => {
  const srv = await server({ choices: [{ message: { content: 'OpenAI reply.' } }] });
  try {
    const c = config({ apiModel: 'some-model' });
    const p = openaiProvider(c, srv.url);
    expect(await p.available(c)).toBe(false);
    process.env.OPENAI_API_KEY = 'test-key';
    expect(await p.polish('the prompt', 5000)).toBe('OpenAI reply.');
    expect(srv.seen.url).toBe('/v1/chat/completions');
    expect(srv.seen.headers?.authorization).toBe('Bearer test-key');
    expect(srv.seen.body).toMatchObject({
      model: 'some-model',
      messages: [{ role: 'user', content: 'the prompt' }],
    });
  } finally {
    srv.close();
  }
});

test('an HTTP error status throws', async () => {
  const srv = await server({ error: { message: 'bad key' } }, 401);
  try {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const c = config({ apiModel: 'm' });
    await expect(anthropicProvider(c, srv.url).polish('p', 5000)).rejects.toThrow(/401/);
  } finally {
    srv.close();
  }
});
