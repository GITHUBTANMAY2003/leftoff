import { CONFIG_KEYS, getConfigValue, setConfigValue } from '../../core/config.ts';

// `leftoff config [list | get <key> | set <key> <value>]` (§1.10).
const USAGE = 'Usage: leftoff config (list | get <key> | set <key> <value>)';

const show = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export async function runConfig(args: string[]): Promise<{ output: string; exitCode: number }> {
  const [action = 'list', key, ...rest] = args;
  const fail = (output: string) => ({ output, exitCode: 1 });
  try {
    if (action === 'list' && key === undefined) {
      const lines = CONFIG_KEYS.map((k) => `${k} = ${show(getConfigValue(k))}`);
      return { output: lines.join('\n'), exitCode: 0 };
    }
    if (action === 'get' && key !== undefined && rest.length === 0) {
      return { output: show(getConfigValue(key)), exitCode: 0 };
    }
    if (action === 'set' && key !== undefined && rest.length > 0) {
      setConfigValue(key, rest.join(' '));
      return { output: `${key} = ${show(getConfigValue(key))}`, exitCode: 0 };
    }
    return fail(USAGE);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(
      message.startsWith('unknown key')
        ? `${message}. Run \`leftoff config list\` for the keys`
        : message,
    );
  }
}
