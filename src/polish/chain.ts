import { POLISH_PROVIDERS, type Config, type PolishProviderName } from '../core/config.ts';
import { logError } from '../core/logger.ts';
import { validatePolish } from './prompt.ts';
import { anthropicProvider } from './providers/anthropic.ts';
import { claudeCli } from './providers/claude-cli.ts';
import { codexCli } from './providers/codex-cli.ts';
import { ollamaProvider } from './providers/ollama.ts';
import { openaiProvider } from './providers/openai.ts';
import type { PolishProvider } from './types.ts';

export function allProviders(config: Config): Record<PolishProviderName, PolishProvider> {
  return {
    'claude-cli': claudeCli,
    'codex-cli': codexCli,
    ollama: ollamaProvider(config),
    anthropic: anthropicProvider(config),
    openai: openaiProvider(config),
  };
}

// polish.provider: off → none; auto → the enabled providers in the fixed order;
// one name → that provider, only if the user enabled it in setup.
export function pickProviders(
  config: Config,
  all: Record<PolishProviderName, PolishProvider> = allProviders(config),
): PolishProvider[] {
  const { provider, enabled } = config.polish;
  if (provider === 'off') return [];
  const names =
    provider === 'auto'
      ? POLISH_PROVIDERS.filter((n) => enabled.includes(n))
      : enabled.includes(provider)
        ? [provider]
        : [];
  return names.map((n) => all[n]);
}

function withTimeout<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Tries each provider in turn; the first valid reply wins. Failures are logged.
export async function polishWith(
  providers: PolishProvider[],
  prompt: string,
  config: Config,
  timeoutMs: number,
): Promise<{ polished: string; provider: PolishProviderName } | null> {
  for (const p of providers) {
    try {
      if (!(await p.available(config))) continue;
      const polished = validatePolish(
        await withTimeout(p.polish(prompt, timeoutMs), timeoutMs, p.name),
      );
      if (polished !== null) return { polished, provider: p.name };
      logError('polish', `${p.name}: reply discarded (empty or longer than 1200 characters)`);
    } catch (err) {
      logError('polish', `${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}
