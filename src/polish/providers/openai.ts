import type { Config } from '../../core/config.ts';
import type { PolishProvider } from '../types.ts';
import { postJson } from './http.ts';

// Chat Completions with the user's key (OPENAI_API_KEY) and the model chosen
// in setup (polish.apiModel); no model id is hardcoded (spec §1.9).
export function openaiProvider(config: Config, baseUrl = 'https://api.openai.com'): PolishProvider {
  return {
    name: 'openai',
    available: (c) =>
      Promise.resolve(Boolean(process.env.OPENAI_API_KEY) && c.polish.apiModel !== null),
    polish: async (prompt, timeoutMs) => {
      const headers = { authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` };
      const body = { model: config.polish.apiModel, messages: [{ role: 'user', content: prompt }] };
      const r = (await postJson(`${baseUrl}/v1/chat/completions`, headers, body, timeoutMs)) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const text = r.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('openai: no text in the response');
      return text;
    },
  };
}
