import type { Config } from '../../core/config.ts';
import type { PolishProvider } from '../types.ts';
import { postJson } from './http.ts';

// The Messages API with the user's key (ANTHROPIC_API_KEY) and the model chosen
// in setup (polish.apiModel); no model id is hardcoded (spec §1.9).
export function anthropicProvider(
  config: Config,
  baseUrl = 'https://api.anthropic.com',
): PolishProvider {
  return {
    name: 'anthropic',
    available: (c) =>
      Promise.resolve(Boolean(process.env.ANTHROPIC_API_KEY) && c.polish.apiModel !== null),
    polish: async (prompt, timeoutMs) => {
      const headers = {
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': '2026-10-21',
      };
      const body = {
        model: config.polish.apiModel,
        max_tokens: 4000, // the paragraph is short; room for the model's thinking
        messages: [{ role: 'user', content: prompt }],
      };
      const r = (await postJson(`${baseUrl}/v1/messages`, headers, body, timeoutMs)) as {
        content?: { type: string; text?: string }[];
      };
      const text = (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '');
      if (text.length === 0) throw new Error('anthropic: no text in the response');
      return text.join('');
    },
  };
}
