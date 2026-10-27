import {
  appendFileSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  closeSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { zstdCompressSync } from 'node:zlib';
import { readJsonlFrom, readZstJsonl } from '../../src/collectors/jsonl-reader.ts';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leftoff-jsonl-'));
  file = join(dir, 'session.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (v: unknown) => JSON.stringify(v) + '\n';
const bytes = (s: string) => Buffer.byteLength(s);

test('reader returns complete lines only and correct nextOffset', async () => {
  const a = line({ n: 1 });
  const b = line({ n: 2, text: 'héllo 😀' });
  writeFileSync(file, a + b + '{"n":3,"partial');
  const r = await readJsonlFrom(file, 0, 1_000_000);
  expect(r.records).toEqual([
    { value: { n: 1 }, endOffset: bytes(a) },
    { value: { n: 2, text: 'héllo 😀' }, endOffset: bytes(a + b) },
  ]);
  expect(r.nextOffset).toBe(bytes(a + b));
  expect(r.malformed).toBe(0);
});

test('reading again from nextOffset continues where it stopped', async () => {
  const a = line({ n: 1 });
  writeFileSync(file, a + '{"n":2');
  const first = await readJsonlFrom(file, 0, 1_000_000);
  appendFileSync(file, '}\n' + line({ n: 3 }));
  const second = await readJsonlFrom(file, first.nextOffset, 1_000_000);
  expect(second.records.map((r) => r.value)).toEqual([{ n: 2 }, { n: 3 }]);
});

test('reader restarts at 0 when file shrank', async () => {
  writeFileSync(file, line({ n: 1 }) + line({ n: 2 }) + line({ n: 3 }));
  const before = await readJsonlFrom(file, 0, 1_000_000);
  writeFileSync(file, line({ n: 'new' })); // rotated / truncated
  const after = await readJsonlFrom(file, before.nextOffset, 1_000_000);
  expect(after.records.map((r) => r.value)).toEqual([{ n: 'new' }]);
});

test('reader stops at maxBytes and resumes next call', async () => {
  const lines = [1, 2, 3, 4].map((n) => line({ n, pad: 'x'.repeat(20) }));
  writeFileSync(file, lines.join(''));
  const max = bytes(lines[0] as string) + 5; // one line and a bit
  const first = await readJsonlFrom(file, 0, max);
  expect(first.records.map((r) => r.value)).toEqual([{ n: 1, pad: 'x'.repeat(20) }]);
  const second = await readJsonlFrom(file, first.nextOffset, max);
  expect(second.records.map((r) => (r.value as { n: number }).n)).toEqual([2]);
});

test('malformed lines are skipped and counted; blank lines and CRLF are fine', async () => {
  writeFileSync(file, line({ n: 1 }) + '{oops\n' + '\n' + '{"n":2}\r\n' + 'not json\n');
  const r = await readJsonlFrom(file, 0, 1_000_000);
  expect(r.records.map((x) => x.value)).toEqual([{ n: 1 }, { n: 2 }]);
  expect(r.malformed).toBe(2);
});

test('a single line longer than maxBytes is skipped as malformed instead of stalling', async () => {
  writeFileSync(file, line({ big: 'y'.repeat(200) }) + line({ n: 'after' }));
  const seen: unknown[] = [];
  let offset = 0;
  let malformed = 0;
  for (let i = 0; i < 20 && seen.length === 0; i++) {
    const r = await readJsonlFrom(file, offset, 50);
    seen.push(...r.records.map((x) => x.value));
    malformed += r.malformed;
    offset = r.nextOffset;
  }
  expect(seen).toEqual([{ n: 'after' }]);
  expect(malformed).toBeGreaterThanOrEqual(1);
});

test('lines crossing the internal read-chunk boundary are joined correctly', async () => {
  // > 1 MiB of lines with multi-byte characters, so chunk edges fall inside lines.
  const lines = Array.from({ length: 3000 }, (_, n) => line({ n, text: 'é😀'.repeat(100) }));
  writeFileSync(file, lines.join(''));
  const r = await readJsonlFrom(file, 0, 50_000_000);
  expect(r.records).toHaveLength(3000);
  expect(r.malformed).toBe(0);
  expect(r.records.at(-1)?.endOffset).toBe(bytes(lines.join('')));
});

test('a missing file rejects with ENOENT', async () => {
  await expect(readJsonlFrom(join(dir, 'nope.jsonl'), 0, 100)).rejects.toThrow(/ENOENT/);
});

test.skipIf(process.env.CI_FAST)(
  'reader handles a 60 MB synthetic file within 3 s for the first 50 MB',
  async () => {
    const record = line({ type: 'assistant', message: { content: 'z'.repeat(900) } });
    const fd = openSync(file, 'w');
    const block = record.repeat(1000);
    for (let written = 0; written < 60 * 1024 * 1024; written += bytes(block)) writeSync(fd, block);
    closeSync(fd);
    const started = Date.now();
    const r = await readJsonlFrom(file, 0, 50 * 1024 * 1024);
    const elapsed = Date.now() - started;
    expect(r.nextOffset).toBeLessThanOrEqual(50 * 1024 * 1024);
    expect(r.nextOffset).toBeGreaterThan(49 * 1024 * 1024);
    expect(r.records.length).toBeGreaterThan(50_000);
    expect(elapsed).toBeLessThan(3000);
  },
  30_000,
);

test('readZstJsonl reads every line of a zstd file and skips the first N', async () => {
  const lines = [1, 2, 3].map((n) => line({ n }));
  const zst = join(dir, 'session.jsonl.zst');
  writeFileSync(zst, zstdCompressSync(Buffer.from(lines.join('') + '{bad\n' + line({ n: 4 }))));
  const all = await readZstJsonl(zst, 0);
  expect(all.records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  expect(all.totalLines).toBe(5);
  expect(all.malformed).toBe(1);
  const rest = await readZstJsonl(zst, 3);
  expect(rest.records).toEqual([{ n: 4 }]);
  expect(rest.totalLines).toBe(5);
});

test('with a passed deadline the reader stops after one chunk but always returns progress', async () => {
  // ~3 MiB of 1 KiB lines: more than one 1 MiB chunk.
  const lines = Array.from({ length: 3000 }, (_, n) => line({ n, pad: 'p'.repeat(1000) }));
  writeFileSync(file, lines.join(''));
  const seen: number[] = [];
  let offset = 0;
  let runs = 0;
  for (; runs < 20 && offset < bytes(lines.join('')); runs++) {
    const r = await readJsonlFrom(file, offset, 50_000_000, 0); // deadline long gone
    expect(r.records.length).toBeGreaterThan(0); // progress every run
    seen.push(...r.records.map((x) => (x.value as { n: number }).n));
    offset = r.nextOffset;
  }
  expect(runs).toBeGreaterThan(1);
  expect(seen).toEqual(lines.map((_, n) => n)); // every line exactly once, in order
});

test('with a passed deadline the zst reader stops after a batch of lines, then continues', async () => {
  const lines = Array.from({ length: 2500 }, (_, n) => line({ n }));
  const zst = join(dir, 'big.jsonl.zst');
  writeFileSync(zst, zstdCompressSync(Buffer.from(lines.join(''))));
  const seen: number[] = [];
  let skip = 0;
  let runs = 0;
  for (let complete = false; !complete && runs < 10; runs++) {
    const r = await readZstJsonl(zst, skip, 0);
    seen.push(...r.records.map((x) => (x as { n: number }).n));
    skip = r.totalLines;
    complete = r.complete;
  }
  expect(runs).toBe(3); // 1000 + 1000 + 500 lines
  expect(seen).toEqual(lines.map((_, n) => n));
});
