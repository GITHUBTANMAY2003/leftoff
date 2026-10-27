import type { Config } from '../../core/config.ts';
import type { PolishProvider } from '../types.ts';
import { postJson } from './http.ts';

// Thinking models (qwen3, deepseek-r1, …) may still put their reasoning in a
// <think>…</think> block before the answer.
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

// A local Ollama server with the model chosen in setup (polish.ollamaModel).
// `think: false` asks thinking models to answer without reasoning (Ollama ≥ 0.9).
export function ollamaProvider(config: Config, baseUrl = 'http://127.0.0.1:11434'): PolishProvider {
  return {
    name: 'ollama',
    available: (c) => Promise.resolve(c.polish.ollamaModel !== null),
    polish: async (prompt, timeoutMs) => {
      const body = { model: config.polish.ollamaModel, prompt, stream: false, think: false };
      const r = (await postJson(`${baseUrl}/api/generate`, {}, body, timeoutMs)) as {
        response?: unknown;
      };
      if (typeof r.response !== 'string') throw new Error('ollama: no response text');
      return r.response.replace(THINK_BLOCK, '');
    },
  };
}
