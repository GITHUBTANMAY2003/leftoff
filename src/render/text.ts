// Cuts text to at most `max` characters (code points) with "…", at a word
// boundary when there is one near the end (owner decision after Task 13).
const NEAR_END = 20;

export function clip(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, Math.max(0, max - 1)).join('');
  const space = cut.lastIndexOf(' ');
  const atWord = space > 0 && cut.length - space <= NEAR_END;
  return (atWord ? cut.slice(0, space).replace(/[\s,;:]+$/, '') : cut) + '…';
}

// At most `max` items; the rest become one "+N more" item.
export function capItems(items: string[], max: number): string[] {
  return items.length <= max ? items : [...items.slice(0, max), `+${items.length - max} more`];
}

// Shortens a command from the middle: its first two words (program +
// subcommand) and its end stay, `cargo test … star_import` (owner decision
// after Task 14). Too narrow for that → a plain cut.
export function clipMiddle(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = text.split(' ').slice(0, 2).join(' ');
  const room = max - [...head].length - 3; // " … "
  if (room < 8) return clip(text, max);
  let tail = chars.slice(-room).join('');
  // A tail that starts inside a word loses that partial word.
  if (text[text.length - room - 1] !== ' ') {
    const space = tail.indexOf(' ');
    if (space !== -1) tail = tail.slice(space + 1);
  }
  return `${head} … ${tail}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Wraps text to `width` at spaces (never inside a `command`), never cutting it (owner decision after Task
// 15d). Continuation lines are indented two more spaces than `prefix`.
export function wrap(prefix: string, text: string, width: number): string[] {
  const room = width - [...prefix].length;
  const lines: string[] = [];
  let current = '';
  // a `command` in backticks is one word, so a line doesn't break inside it —
  // unless it is longer than a whole line, then it breaks at its spaces
  const max = room - 2;
  const words = (text.match(/[^\s`]*`[^`]*`\S*|\S+/g) ?? [])
    .flatMap((w) => ([...w].length > max ? w.split(' ') : [w]))
    // a single word longer than a line (a long path) continues on the next
    .flatMap((w) => {
      const chars = [...w];
      if (chars.length <= max) return [w];
      const parts: string[] = [];
      for (let i = 0; i < chars.length; i += max) parts.push(chars.slice(i, i + max).join(''));
      return parts;
    });
  for (const word of words) {
    const next = current === '' ? word : `${current} ${word}`;
    if ([...next].length > room - (lines.length > 0 ? 2 : 0) && current !== '') {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current !== '') lines.push(current);
  return lines.map((l, i) => `${prefix}${i > 0 ? '  ' : ''}${l}`);
}
