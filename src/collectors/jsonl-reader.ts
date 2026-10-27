import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

// Incremental reading of append-only JSONL logs (agent transcripts, plan §1.6):
// only complete lines are returned, the offset never moves past a partial last
// line, and one call reads at most maxBytes so a huge log can't stall a brief.

const CHUNK_BYTES = 1 << 20;
const NEWLINE = 0x0a;

export interface JsonlRead {
  records: { value: unknown; endOffset: number }[]; // endOffset: byte just after the line
  nextOffset: number;
  malformed: number;
}

export async function readJsonlFrom(
  file: string,
  offset: number,
  maxBytes: number,
): Promise<JsonlRead> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = offset > size ? 0 : offset; // the file shrank: rotated or rewritten
    const end = Math.min(size, start + maxBytes);
    const result: JsonlRead = { records: [], nextOffset: start, malformed: 0 };
    let pos = start;
    let pending: Buffer[] = []; // bytes of a line that continues into the next chunk

    while (pos < end) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - pos));
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      let from = 0;
      for (
        let nl = buf.indexOf(NEWLINE, from);
        nl !== -1 && nl < bytesRead;
        nl = buf.indexOf(NEWLINE, from)
      ) {
        const piece = buf.subarray(from, nl);
        const line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
        pending = [];
        from = nl + 1;
        result.nextOffset = pos + from;
        const text = line.toString('utf8').replace(/\r$/, '');
        if (text.trim() === '') continue;
        try {
          result.records.push({ value: JSON.parse(text) as unknown, endOffset: result.nextOffset });
        } catch {
          result.malformed++;
        }
      }
      if (from < bytesRead) pending.push(buf.subarray(from, bytesRead));
      pos += bytesRead;
    }

    // Not one complete line within maxBytes, and the file goes on: the line is
    // longer than the budget and could never be read. Skip it.
    if (result.nextOffset === start && end === start + maxBytes && end < size) {
      result.malformed++;
      result.nextOffset = end;
    }
    return result;
  } finally {
    await handle.close();
  }
}

// Compressed sessions (Codex rewrites older rollouts as .jsonl.zst). The file
// is complete, so it is streamed in full; the first `skipLines` lines were
// read before. Uses node:zlib's zstd (Node ≥ 22.15), no extra dependency.
export async function readZstJsonl(
  file: string,
  skipLines: number,
): Promise<{ records: unknown[]; totalLines: number; malformed: number }> {
  const result = { records: [] as unknown[], totalLines: 0, malformed: 0 };
  const lines = createInterface({
    input: createReadStream(file).pipe(createZstdDecompress()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    result.totalLines++;
    if (result.totalLines <= skipLines || line.trim() === '') continue;
    try {
      result.records.push(JSON.parse(line) as unknown);
    } catch {
      result.malformed++;
    }
  }
  return result;
}
