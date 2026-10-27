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

// With a deadline (epoch ms), reading stops between 1 MiB chunks once it has
// passed, as long as at least one line was read.
export async function readJsonlFrom(
  file: string,
  offset: number,
  maxBytes: number,
  deadline?: number,
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
      const progressed = result.records.length + result.malformed > 0;
      if (progressed && deadline !== undefined && Date.now() >= deadline) break;
    }

    // Not one complete line within maxBytes, and the file goes on: the line is
    // longer than the budget and could never be read. Skip it.
    if (result.nextOffset === start && pos === start + maxBytes && end < size) {
      result.malformed++;
      result.nextOffset = end;
    }
    return result;
  } finally {
    await handle.close();
  }
}

// Compressed sessions (Codex rewrites older rollouts as .jsonl.zst). The file
// is streamed; the first `skipLines` lines were read before. With a deadline
// it stops after a batch of ZST_BATCH_LINES new lines once the deadline has
// passed: `totalLines` is then the lines consumed and `complete` is false.
// Uses node:zlib's zstd (Node ≥ 22.15), no extra dependency.
const ZST_BATCH_LINES = 1000;

export async function readZstJsonl(
  file: string,
  skipLines: number,
  deadline?: number,
): Promise<{ records: unknown[]; totalLines: number; malformed: number; complete: boolean }> {
  const result = { records: [] as unknown[], totalLines: 0, malformed: 0, complete: true };
  const input = createReadStream(file);
  const decompressed = input.pipe(createZstdDecompress());
  const lines = createInterface({ input: decompressed, crlfDelay: Infinity });
  for await (const line of lines) {
    const fresh = result.totalLines - skipLines;
    if (
      fresh > 0 &&
      fresh % ZST_BATCH_LINES === 0 &&
      deadline !== undefined &&
      Date.now() >= deadline
    ) {
      result.complete = false;
      lines.close();
      decompressed.destroy();
      input.destroy();
      break;
    }
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
