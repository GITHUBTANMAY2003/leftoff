import type { Config } from '../core/config.ts';
import { claudeCollector } from './claude.ts';
import { codexCollector } from './codex.ts';
import { gitCollector } from './git.ts';
import { shellCollector } from './shell.ts';
import type { Collector } from './types.ts';

// Order matters: git runs last, so it sees projects the others just found.
const ALL: Collector[] = [claudeCollector, codexCollector, shellCollector, gitCollector];

// The collectors enabled in config.collectors (plan Task 8).
export function collectors(config: Config): Collector[] {
  return ALL.filter((c) => config.collectors[c.name as keyof Config['collectors']]);
}
