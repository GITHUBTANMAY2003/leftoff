import type { BriefFacts } from '../brief/facts.ts';
import { clip, clipMiddle } from './text.ts';

// Terminal helpers shared by the renderers: line fitting, colors and the
// Sources line (the brief itself is in narrative.ts and details.ts).

// Each fact line is cut to this many characters (code points) with "…"; only
// the terminal does this (owner decision after Task 10).
export const LINE_WIDTH = 100;

export function fit(prefix: string, text: string, width = LINE_WIDTH): string {
  return clip(text, width - [...prefix].length);
}

// Cuts `text` but keeps `tail` whole after it, so an ending such as
// "(still failing)" or "(2 attempts)" always survives (owner decision, Task 11).
export function fitKeepingTail(prefix: string, text: string, tail: string): string {
  return fit(prefix + tail, text) + tail;
}

// A problem line is "`command` — error". When it is too long the command is
// shortened from the middle, so the error stays visible (owner decision after
// Task 14); text that isn't in that form is cut at the end. `tail` is an
// ending that follows the result (its width is reserved, it is not added).
const PROBLEM_LINE = /^`(.*?)` — ([\s\S]*)$/;
const MIN_ERROR_CHARS = 40;
const MIN_COMMAND_CHARS = 20;
export function fitProblemLine(prefix: string, text: string, tail = ''): string {
  const m = PROBLEM_LINE.exec(text);
  if (!m) return fit(prefix + tail, text);
  const [command, error] = [m[1] as string, m[2] as string];
  const room = LINE_WIDTH - [...(prefix + tail)].length - 5; // two backticks and " — "
  const [commandLen, errorLen] = [[...command].length, [...error].length];
  if (commandLen + errorLen <= room) return text;
  const shownCommand = clipMiddle(
    command,
    Math.max(room - Math.min(errorLen, MIN_ERROR_CHARS), MIN_COMMAND_CHARS),
  );
  const shownError = clip(error, Math.max(room - [...shownCommand].length, 1));
  return `\`${shownCommand}\` — ${shownError}`;
}

const STATUS_MARK = { ok: '✓', not_found: '–', error: '!' } as const;

type Paint = (text: string) => string;
export function painter(color: boolean) {
  const wrap =
    (code: string): Paint =>
    (t) =>
      color ? `\x1b[${code}m${t}\x1b[0m` : t;
  return {
    bold: wrap('1'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    dim: wrap('2'),
  };
}

export function sourcesLine(
  f: BriefFacts,
  separator: string,
  paint?: ReturnType<typeof painter>,
): string {
  const marks = f.sources.map((s) => {
    const mark = STATUS_MARK[s.status];
    const colored = !paint
      ? mark
      : s.status === 'ok'
        ? paint.green(mark)
        : s.status === 'error'
          ? paint.yellow(mark)
          : paint.dim(mark);
    return `${s.name} ${colored}`;
  });
  return `Sources: ${marks.join(separator)}`;
}
