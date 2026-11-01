import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// What a project is, in one line, from its README (owner decision after Task
// 15c): used when there are no commits to say what the work was about. The
// first heading; when the heading is just the project's name, the first
// sentence of the first paragraph ("<name> is …" dropped). Badges, images,
// HTML and code are skipped; markdown emphasis is dropped.

const README = /^readme(\.(md|markdown|rst|txt))?$/i;
const NOT_PROSE = /^(\[!\[|!\[|<|```|~~~|\||>|\[.*\]\(.*\)$|-{3,}$|={3,}$)/;

const plain = (text: string) =>
  text
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
const same = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

export function readmeLine(text: string, project: string): string | null {
  const lines = text.split('\n').map((l) => l.trim());
  let heading: string | null = null;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l === '') continue;
    if (/^#{1,6}\s/.test(l)) {
      heading = plain(l.replace(/^#+\s*/, ''));
      start = i + 1;
    } else if (/^(=+|-+)$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').length >= 3) {
      heading = plain(l);
      start = i + 2;
    }
    break;
  }
  if (heading !== null && heading !== '' && !same(heading, project)) return heading;
  // The first prose line after the heading, then its first sentence.
  let fenced = false;
  for (const l of lines.slice(start)) {
    if (/^(```|~~~)/.test(l)) fenced = !fenced;
    if (fenced || l === '' || NOT_PROSE.test(l) || /^#/.test(l)) continue;
    const prose = plain(l);
    if (prose === '') continue;
    let sentence = prose.split(/(?<=[.!?])\s+/)[0] as string;
    sentence = sentence.replace(/[.!]+$/, '');
    const named = new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+is\\s+`, 'i');
    sentence = sentence.replace(named, '');
    return sentence === '' ? null : sentence; // whole: cut only at the sentence boundary
  }
  return null;
}

export function readmeOneLiner(root: string): string | null {
  try {
    const file = readdirSync(root).find((f) => README.test(f));
    if (file === undefined) return null;
    return readmeLine(readFileSync(join(root, file), 'utf8').slice(0, 20_000), basename(root));
  } catch {
    return null; // unreadable folder or file: no one-liner
  }
}
