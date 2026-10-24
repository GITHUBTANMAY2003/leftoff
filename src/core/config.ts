import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { logError } from './logger.ts';
import { ensureHome, paths } from './paths.ts';

export const POLISH_PROVIDERS = [
  'claude-cli',
  'codex-cli',
  'ollama',
  'anthropic',
  'openai',
] as const;
export type PolishProviderName = (typeof POLISH_PROVIDERS)[number];
export type PolishSetting = 'off' | 'auto' | PolishProviderName;

export interface Config {
  sessionGapMinutes: number;
  retentionDays: number;
  autoBrief: { enabled: boolean; gapHours: number };
  ingest: { maxBytesPerFilePerRun: number };
  codex: { maxCompressedMb: number };
  collectors: { claude: boolean; codex: boolean; shell: boolean; git: boolean };
  ignore: { projects: string[]; commands: string[] };
  polish: {
    provider: PolishSetting;
    enabled: PolishProviderName[];
    ollamaModel: string | null;
    apiModel: string | null;
  };
  looseEnds: { staleDays: number; maxProjects: number };
}

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze<Config>({
  sessionGapMinutes: 45,
  retentionDays: 30,
  autoBrief: { enabled: true, gapHours: 4 },
  ingest: { maxBytesPerFilePerRun: 52428800 },
  codex: { maxCompressedMb: 200 },
  collectors: { claude: true, codex: true, shell: true, git: true },
  ignore: { projects: [], commands: [] },
  polish: { provider: 'off', enabled: [], ollamaModel: null, apiModel: null },
  looseEnds: { staleDays: 3, maxProjects: 20 },
});

type Kind =
  | { type: 'number' }
  | { type: 'integer' }
  | { type: 'boolean' }
  | { type: 'nullableString' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'list'; values?: readonly string[] };

// Durations may be decimal; counts and sizes must be whole numbers.
const NUMBER: Kind = { type: 'number' };
const INTEGER: Kind = { type: 'integer' };
const BOOLEAN: Kind = { type: 'boolean' };

// Every settable leaf key. Hand-written validation: no schema library (plan Task 1).
const FIELDS: Record<string, Kind> = {
  sessionGapMinutes: NUMBER,
  retentionDays: INTEGER,
  'autoBrief.enabled': BOOLEAN,
  'autoBrief.gapHours': NUMBER,
  'ingest.maxBytesPerFilePerRun': INTEGER,
  'codex.maxCompressedMb': INTEGER,
  'collectors.claude': BOOLEAN,
  'collectors.codex': BOOLEAN,
  'collectors.shell': BOOLEAN,
  'collectors.git': BOOLEAN,
  'ignore.projects': { type: 'list' },
  'ignore.commands': { type: 'list' },
  'polish.provider': { type: 'enum', values: ['off', 'auto', ...POLISH_PROVIDERS] },
  'polish.enabled': { type: 'list', values: POLISH_PROVIDERS },
  'polish.ollamaModel': { type: 'nullableString' },
  'polish.apiModel': { type: 'nullableString' },
  'looseEnds.staleDays': NUMBER,
  'looseEnds.maxProjects': INTEGER,
};

const SECTIONS = new Set(
  Object.keys(FIELDS)
    .filter((k) => k.includes('.'))
    .map((k) => k.split('.')[0]),
);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function getPath(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, part) => (isPlainObject(o) ? o[part] : undefined), obj);
}

function setPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  const last = parts.pop() as string;
  let target = obj;
  for (const part of parts) target = target[part] as Record<string, unknown>;
  target[last] = value;
}

// Validates a value read from config.json (already JSON-typed).
function isValid(kind: Kind, v: unknown): boolean {
  switch (kind.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    case 'integer':
      return Number.isSafeInteger(v) && (v as number) >= 0;
    case 'boolean':
      return typeof v === 'boolean';
    case 'nullableString':
      return v === null || typeof v === 'string';
    case 'enum':
      return typeof v === 'string' && kind.values.includes(v);
    case 'list':
      return (
        Array.isArray(v) &&
        v.every((item) => typeof item === 'string' && (!kind.values || kind.values.includes(item)))
      );
  }
}

// Parses a raw command-line string for `leftoff config set`.
function parseRaw(key: string, kind: Kind, raw: string): unknown {
  const s = raw.trim();
  switch (kind.type) {
    case 'number':
      if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${key} must be a number ≥ 0, got "${raw}"`);
      return Number(s);
    case 'integer':
      if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s))) {
        throw new Error(`${key} must be an integer (a whole number ≥ 0), got "${raw}"`);
      }
      return Number(s);
    case 'boolean':
      if (s !== 'true' && s !== 'false')
        throw new Error(`${key} must be true or false, got "${raw}"`);
      return s === 'true';
    case 'nullableString':
      return s === '' ? null : s;
    case 'enum':
      if (!kind.values.includes(s)) {
        throw new Error(`${key} must be one of: ${kind.values.join(', ')}; got "${raw}"`);
      }
      return s;
    case 'list': {
      const items =
        s === ''
          ? []
          : s
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean);
      const bad = kind.values ? items.filter((item) => !kind.values?.includes(item)) : [];
      if (bad.length > 0) {
        throw new Error(
          `${key} items must be one of: ${kind.values?.join(', ')}; got "${bad.join(', ')}"`,
        );
      }
      return items;
    }
  }
}

function defaults(): Config {
  return structuredClone(DEFAULT_CONFIG) as Config;
}

export function loadConfig(): Config {
  const file = paths().config;
  const config = defaults();
  if (!existsSync(file)) return config;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    logError('config', `cannot read ${file}, using defaults: ${String(err)}`);
    return config;
  }
  if (!isPlainObject(parsed)) {
    logError('config', `${file} is not a JSON object, using defaults`);
    return config;
  }

  for (const [top, value] of Object.entries(parsed)) {
    if (SECTIONS.has(top)) {
      if (!isPlainObject(value)) {
        logError('config', `invalid value for ${top} (expected an object), using defaults`);
        continue;
      }
      for (const [sub, subValue] of Object.entries(value))
        applyFileValue(config, `${top}.${sub}`, subValue);
    } else {
      applyFileValue(config, top, value);
    }
  }
  return config;
}

function applyFileValue(config: Config, key: string, value: unknown): void {
  const kind = FIELDS[key];
  if (!kind) {
    logError('config', `unknown key "${key}" in config file dropped`);
  } else if (!isValid(kind, value)) {
    logError('config', `invalid value for ${key} in config file, using default`);
  } else {
    setPath(config as unknown as Record<string, unknown>, key, value);
  }
}

export function saveConfig(c: Config): void {
  ensureHome();
  const file = paths().config;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export function getConfigValue(key: string): unknown {
  if (!FIELDS[key]) throw new Error(`unknown key: ${key}`);
  return getPath(loadConfig(), key);
}

// Parses, validates and saves one value; returns the full updated config.
export function setConfigValue(key: string, raw: string): Config {
  const kind = FIELDS[key];
  if (!kind) throw new Error(`unknown key: ${key}`);
  const value = parseRaw(key, kind, raw);
  const config = loadConfig();
  setPath(config as unknown as Record<string, unknown>, key, value);
  saveConfig(config);
  return config;
}
