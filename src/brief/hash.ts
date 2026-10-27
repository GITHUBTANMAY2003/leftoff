import { createHash } from 'node:crypto';
import type { BriefFacts } from './facts.ts';

// Identifies the facts a polished summary was written for (Task 12). The time
// of last activity and the source statuses don't change what the brief says.
export function factsHash(f: BriefFacts): string {
  const hashed = { ...f, lastActiveAt: undefined, sources: undefined }; // JSON drops undefined
  return createHash('sha1').update(JSON.stringify(hashed)).digest('hex');
}
