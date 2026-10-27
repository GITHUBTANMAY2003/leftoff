import { expect, test } from 'vitest';
import { runConfig } from '../../src/cli/commands/config.ts';
import { loadConfig } from '../../src/core/config.ts';
import { useTempHome } from '../helpers/home.ts';

useTempHome();

test('config set / get / list round-trip', async () => {
  expect(await runConfig(['get', 'autoBrief.gapHours'])).toEqual({ output: '4', exitCode: 0 });
  expect(await runConfig(['set', 'autoBrief.gapHours', '6'])).toEqual({
    output: 'autoBrief.gapHours = 6',
    exitCode: 0,
  });
  expect(loadConfig().autoBrief.gapHours).toBe(6);
  expect((await runConfig(['get', 'autoBrief.gapHours'])).output).toBe('6');
  await runConfig(['set', 'ignore.projects', '/a, /b']);
  expect((await runConfig(['get', 'ignore.projects'])).output).toBe('["/a","/b"]');
  await runConfig(['set', 'polish.provider', 'off']);
  const list = (await runConfig(['list'])).output.split('\n');
  expect(list).toContain('autoBrief.gapHours = 6');
  expect(list).toContain('ignore.projects = ["/a","/b"]');
  expect(list).toContain('polish.provider = off');
  expect(list).toContain('polish.ollamaModel = null');
  expect(list.length).toBeGreaterThanOrEqual(18); // every settable key
  expect((await runConfig([])).output).toBe((await runConfig(['list'])).output);
});

test('config rejects unknown keys and bad values without changing the file', async () => {
  const unknown = await runConfig(['get', 'nope']);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.output).toMatch(/unknown key: nope.*leftoff config list/);
  expect((await runConfig(['set', 'nope', '1'])).exitCode).toBe(1);
  const bad = await runConfig(['set', 'retentionDays', '1.5']);
  expect(bad.exitCode).toBe(1);
  expect(bad.output).toMatch(/retentionDays must be an integer/);
  expect(loadConfig().retentionDays).toBe(30);
  const usage = await runConfig(['get']);
  expect(usage.exitCode).toBe(1);
  expect(usage.output).toMatch(/Usage: leftoff config/);
  expect((await runConfig(['frobnicate'])).exitCode).toBe(1);
});

test('config set joins a value with spaces', async () => {
  await runConfig(['set', 'polish.ollamaModel', 'my', 'model']);
  expect((await runConfig(['get', 'polish.ollamaModel'])).output).toBe('my model');
});
