import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DEFAULT_CONFIG, type Config, type PolishProviderName } from '../../src/core/config.ts';
import { pickProviders, polishWith } from '../../src/polish/chain.ts';
import type { PolishProvider } from '../../src/polish/types.ts';

let tmp: string;
const savedHome = process.env.LEFTOFF_HOME;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-chain-'));
  process.env.LEFTOFF_HOME = tmp; // errors are logged here
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

const config = (polish: Partial<Config['polish']>): Config => {
  const c = structuredClone(DEFAULT_CONFIG) as Config;
  c.polish = { ...c.polish, ...polish };
  return c;
};

function fake(
  name: PolishProviderName,
  reply: () => Promise<string>,
  available = true,
): PolishProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    available: () => Promise.resolve(available),
    polish: () => {
      p.calls++;
      return reply();
    },
  };
  return p;
}
const all = (overrides: Partial<Record<PolishProviderName, PolishProvider>> = {}) => ({
  'claude-cli': fake('claude-cli', () => Promise.resolve('c')),
  'codex-cli': fake('codex-cli', () => Promise.resolve('x')),
  ollama: fake('ollama', () => Promise.resolve('o')),
  anthropic: fake('anthropic', () => Promise.resolve('a')),
  openai: fake('openai', () => Promise.resolve('p')),
  ...overrides,
});
const names = (ps: PolishProvider[]) => ps.map((p) => p.name);

test('off → no providers', () => {
  expect(pickProviders(config({ provider: 'off', enabled: ['claude-cli'] }), all())).toEqual([]);
});

test('auto → the enabled providers, in the fixed order', () => {
  const c = config({ provider: 'auto', enabled: ['openai', 'ollama', 'claude-cli'] });
  expect(names(pickProviders(c, all()))).toEqual(['claude-cli', 'ollama', 'openai']);
});

test('a single provider name → that one only if it is enabled', () => {
  expect(names(pickProviders(config({ provider: 'ollama', enabled: ['ollama'] }), all()))).toEqual([
    'ollama',
  ]);
  expect(pickProviders(config({ provider: 'ollama', enabled: ['claude-cli'] }), all())).toEqual([]);
});

test('auto tries next provider when first throws or times out', async () => {
  const throws = fake('claude-cli', () => Promise.reject(new Error('boom')));
  const hangs = fake('codex-cli', () => new Promise<string>(() => {}));
  const works = fake('ollama', () => Promise.resolve('You were fixing SMTP.'));
  const c = config({ provider: 'auto' });
  const started = Date.now();
  expect(await polishWith([throws, hangs, works], 'prompt', c, 50)).toEqual({
    polished: 'You were fixing SMTP.',
    provider: 'ollama',
  });
  expect(Date.now() - started).toBeLessThan(2000);
  expect([throws.calls, hangs.calls, works.calls]).toEqual([1, 1, 1]);
});

test('invalid polish output is discarded', async () => {
  const empty = fake('claude-cli', () => Promise.resolve('   '));
  const tooLong = fake('codex-cli', () => Promise.resolve('a'.repeat(1201)));
  const c = config({ provider: 'auto' });
  expect(await polishWith([empty, tooLong], 'prompt', c, 1000)).toBeNull();
  const good = fake('ollama', () => Promise.resolve(' Fine. '));
  expect(await polishWith([empty, good], 'prompt', c, 1000)).toEqual({
    polished: 'Fine.',
    provider: 'ollama',
  });
});

test('an unavailable provider is skipped without being called', async () => {
  const missing = fake('claude-cli', () => Promise.resolve('never'), false);
  const works = fake('ollama', () => Promise.resolve('ok'));
  expect(await polishWith([missing, works], 'p', config({}), 1000)).toEqual({
    polished: 'ok',
    provider: 'ollama',
  });
  expect(missing.calls).toBe(0);
});
