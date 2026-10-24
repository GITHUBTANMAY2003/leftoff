// Secret redaction (P10, plan Task 3). Applied to every summary and data value
// before anything is stored. Over-redacting is safe; under-redacting is not.

const R = '[REDACTED]';

// Names of variables, flags and JSON keys whose values are secrets. "pass" and
// "auth" only count as a whole name segment, so --author and passport stay.
const SECRET_SUBSTRING = /password|passwd|passphrase|secret|token|api[_-]?key/i;
const SECRET_SEGMENT = /(^|[^a-z])(pass|auth|authorization)([^a-z]|$)/i;

function isSecretName(name: string): boolean {
  return SECRET_SUBSTRING.test(name) || SECRET_SEGMENT.test(name);
}

// Order matters: whole blocks and structured forms first, then bare tokens,
// then name-based assignments (which also catch what is already [REDACTED]).
const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, `$1${R}$2`],
  // URL credentials: scheme://user:pass@host
  [/(:\/\/[^\s:/@]+:)[^\s@/]+@/g, `$1${R}@`],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${R}`],
  [/\bAKIA[0-9A-Z]{16}\b/g, R],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, R],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, R],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, R],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, R],
  // "password": "value"
  [
    /("([^"]*)"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (whole, prefix, key) => (isSecretName(key as string) ? `${prefix}"${R}"` : (whole as string)),
  ],
  // NAME=value, --name=value
  [
    /([A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|[^\s"'&]+)/g,
    (whole, name) => (isSecretName(name as string) ? `${name}=${R}` : (whole as string)),
  ],
  // --name value (the value must not look like the next flag)
  [
    /(--?[A-Za-z][A-Za-z0-9_-]*)(\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g,
    (whole, flag, space) =>
      isSecretName((flag as string).replace(/^-+/, '')) ? `${flag}${space}${R}` : (whole as string),
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
  }
  return out;
}

// Returns a redacted deep copy. String values under a secret-named key are
// replaced entirely, because a bare value like "hunter2" has no pattern to match.
export function redactDeep<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(value: unknown, secretKey: boolean): unknown {
  if (typeof value === 'string') return secretKey ? R : redact(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, secretKey));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, isSecretName(k))]));
  }
  return value;
}
