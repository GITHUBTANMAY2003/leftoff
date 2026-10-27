// Time display and --since parsing. Timestamps are stored as UTC ISO strings
// and shown relative to now; "today"/"yesterday"/dates mean local midnights.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeAgo(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

const localMidnight = (y: number, monthIndex: number, d: number) => new Date(y, monthIndex, d);

// leftoff standup --since <yesterday|today|Nh|YYYY-MM-DD> (§1.10).
export function parseSince(s: string, now: Date): Date {
  const hint = `use yesterday, today, Nh or YYYY-MM-DD`;
  if (s === 'today') return localMidnight(now.getFullYear(), now.getMonth(), now.getDate());
  if (s === 'yesterday') return localMidnight(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const hours = /^(\d+)h$/.exec(s);
  if (hours) return new Date(now.getTime() - Number(hours[1]) * HOUR);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const result = localMidnight(y, m - 1, d);
    // Rejects dates like 2026-02-30, which Date would roll over to March.
    if (result.getFullYear() === y && result.getMonth() === m - 1 && result.getDate() === d)
      return result;
  }
  throw new Error(`unrecognized --since "${s}" (${hint})`);
}
