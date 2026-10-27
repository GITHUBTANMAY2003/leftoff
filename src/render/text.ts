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
