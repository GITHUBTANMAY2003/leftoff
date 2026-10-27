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
