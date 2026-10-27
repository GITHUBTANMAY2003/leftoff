import type { Config, PolishProviderName } from '../core/config.ts';

// An optional AI provider that rewrites the brief facts into a short paragraph
// (spec §1.9). Facts are always shown; the paragraph is only added above them.
export interface PolishProvider {
  name: PolishProviderName;
  available(config: Config): Promise<boolean>;
  polish(prompt: string, timeoutMs: number): Promise<string>;
}
