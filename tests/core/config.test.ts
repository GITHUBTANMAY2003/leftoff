import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  DEFAULT_CONFIG,
  getConfigValue,
  loadConfig,
  saveConfig,
  setConfigValue,
} from '../../src/core/config.ts';
import { readRecentErrors } from '../../src/core/logger.ts';
import { ensureHome, paths } from '../../src/core/paths.ts';

let tmp: string;
const savedHome = process.env.LEFTOFF_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'leftoff-config-'));
  process.env.LEFTOFF_HOME = tmp;
  ensureHome();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LEFTOFF_HOME;
  else process.env.LEFTOFF_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

test('missing config file returns defaults', () => {
  expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  expect(DEFAULT_CONFIG.sessionGapMinutes).toBe(45);
  expect(DEFAULT_CONFIG.autoBrief.gapHours).toBe(4);
  expect(DEFAULT_CONFIG.polish.provider).toBe('off');
});

test('loadConfig returns a copy: mutating it does not change DEFAULT_CONFIG', () => {
  const c = loadConfig();
  c.autoBrief.gapHours = 99;
  c.ignore.projects.push('/x');
  expect(DEFAULT_CONFIG.autoBrief.gapHours).toBe(4);
  expect(DEFAULT_CONFIG.ignore.projects).toEqual([]);
});

test('corrupt config file falls back to defaults and logs', () => {
  writeFileSync(paths().config, '{not json');
  expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  expect(readRecentErrors(1)[0]).toMatch(/config/);
});

test('partial config file is merged over defaults', () => {
  writeFileSync(paths().config, JSON.stringify({ autoBrief: { gapHours: 6 } }));
  const c = loadConfig();
  expect(c.autoBrief).toEqual({ enabled: true, gapHours: 6 });
  expect(c.retentionDays).toBe(30);
});

test('unknown keys in the file are dropped with a log line', () => {
  writeFileSync(paths().config, JSON.stringify({ retentionDays: 10, bogus: 1 }));
  const c = loadConfig();
  expect(c.retentionDays).toBe(10);
  expect(c).not.toHaveProperty('bogus');
  expect(readRecentErrors(1)[0]).toMatch(/bogus/);
});

test('a value of the wrong type in the file falls back to its default with a log line', () => {
  writeFileSync(
    paths().config,
    JSON.stringify({
      sessionGapMinutes: 'soon',
      polish: { provider: 'gpt', ollamaModel: 'llama3' },
    }),
  );
  const c = loadConfig();
  expect(c.sessionGapMinutes).toBe(45);
  expect(c.polish.provider).toBe('off');
  expect(c.polish.ollamaModel).toBe('llama3');
  const errors = readRecentErrors(5).join('\n');
  expect(errors).toMatch(/sessionGapMinutes/);
  expect(errors).toMatch(/polish\.provider/);
});

test('setConfigValue validates types', () => {
  expect(setConfigValue('autoBrief.gapHours', '6').autoBrief.gapHours).toBe(6);
  expect(() => setConfigValue('autoBrief.gapHours', 'abc')).toThrow(/number/);
  expect(() => setConfigValue('nope.key', '1')).toThrow(/unknown key/);
});

test('setConfigValue rejects negative numbers and accepts 0', () => {
  expect(() => setConfigValue('retentionDays', '-1')).toThrow(/number/);
  expect(setConfigValue('autoBrief.gapHours', '0').autoBrief.gapHours).toBe(0);
});

test.each([
  'retentionDays',
  'looseEnds.maxProjects',
  'ingest.maxBytesPerFilePerRun',
  'codex.maxCompressedMb',
])('setConfigValue: count key %s accepts integers and rejects decimals', (key) => {
  expect(getConfigValue(key)).toSatisfy(Number.isInteger);
  expect(setConfigValue(key, '0')).toBeDefined();
  expect(getConfigValue(key)).toBe(0);
  expect(() => setConfigValue(key, '2.5')).toThrow(/integer/);
});

test.each(['autoBrief.gapHours', 'sessionGapMinutes', 'looseEnds.staleDays'])(
  'setConfigValue: duration key %s accepts decimals',
  (key) => {
    setConfigValue(key, '0.5');
    expect(getConfigValue(key)).toBe(0.5);
  },
);

test('a decimal for a count key in the file falls back to its default with a log line', () => {
  writeFileSync(paths().config, JSON.stringify({ retentionDays: 7.5, sessionGapMinutes: 30.5 }));
  const c = loadConfig();
  expect(c.retentionDays).toBe(30);
  expect(c.sessionGapMinutes).toBe(30.5);
  expect(readRecentErrors(1)[0]).toMatch(/retentionDays/);
});

test('setConfigValue saves: the next loadConfig sees the value', () => {
  setConfigValue('retentionDays', '14');
  expect(loadConfig().retentionDays).toBe(14);
});

test('setConfigValue parses booleans strictly', () => {
  expect(setConfigValue('autoBrief.enabled', 'false').autoBrief.enabled).toBe(false);
  expect(setConfigValue('collectors.codex', 'true').collectors.codex).toBe(true);
  expect(() => setConfigValue('autoBrief.enabled', 'yes')).toThrow(/true or false/);
});

test('setConfigValue parses comma-separated lists; "" is empty', () => {
  expect(setConfigValue('ignore.projects', '~/secret/*, /tmp/*').ignore.projects).toEqual([
    '~/secret/*',
    '/tmp/*',
  ]);
  expect(setConfigValue('ignore.projects', '').ignore.projects).toEqual([]);
});

test('setConfigValue: nullable strings, "" means null', () => {
  expect(setConfigValue('polish.ollamaModel', 'llama3').polish.ollamaModel).toBe('llama3');
  expect(setConfigValue('polish.ollamaModel', '').polish.ollamaModel).toBeNull();
});

test('setConfigValue: polish.provider and polish.enabled only accept known names', () => {
  expect(setConfigValue('polish.provider', 'auto').polish.provider).toBe('auto');
  expect(setConfigValue('polish.provider', 'claude-cli').polish.provider).toBe('claude-cli');
  expect(() => setConfigValue('polish.provider', 'gpt')).toThrow(/one of/);
  expect(setConfigValue('polish.enabled', 'claude-cli,ollama').polish.enabled).toEqual([
    'claude-cli',
    'ollama',
  ]);
  expect(() => setConfigValue('polish.enabled', 'claude-cli,off')).toThrow(/one of/);
});

test('setConfigValue refuses section keys', () => {
  expect(() => setConfigValue('autoBrief', '1')).toThrow(/unknown key/);
});

test('getConfigValue reads leaf keys and rejects unknown ones', () => {
  expect(getConfigValue('autoBrief.gapHours')).toBe(4);
  expect(getConfigValue('polish.apiModel')).toBeNull();
  expect(() => getConfigValue('nope')).toThrow(/unknown key/);
});

test('saveConfig writes JSON with mode 0600', () => {
  saveConfig({ ...loadConfig(), retentionDays: 7 });
  expect(statSync(paths().config).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(paths().config, 'utf8')).retentionDays).toBe(7);
});
