import type { OpenProblem } from './facts.ts';
import { checkStep, describeFailure, failureCategory, testScope } from './failure-words.ts';
import { commandFiles } from '../model/event.ts';

// One way to group open problems, used by every view so the counts agree
// (owner decision after Task 15d). A project's test failures are one group
// naming the packages or suites ("Tests fail in 2 packages: a and b"); a
// whole-suite run isn't named when packages already explain it. Formatting
// failures are one group counting the files. The rest group by how they read.

export interface ProblemGroup {
  now: string; // a sentence: "Tests fail in 2 packages: a and b"
  still: string; // after "but": "tests still fail in 2 packages: a and b"
  action: string; // for the next step: "make the tests pass in a and b"
  rerun: string | null; // the command to run again
  problems: OpenProblem[];
}

const capital = (text: string) =>
  /^[a-z]/.test(text) ? text[0]?.toUpperCase() + text.slice(1) : text;
const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const step = (p: OpenProblem) => (p.command === null ? null : checkStep(p.command));
const categoryOf = (p: OpenProblem) => {
  const s = step(p);
  return s === null ? null : failureCategory(s);
};

function single(p: OpenProblem): ProblemGroup {
  const w = describeFailure(p.command, p.error);
  return { now: capital(w.now), still: w.still, action: w.action, rerun: step(p), problems: [p] };
}

function testGroup(problems: OpenProblem[]): ProblemGroup {
  const scopes = problems.map((p) => (step(p) === null ? null : testScope(step(p) as string)));
  const names = [...new Set(scopes.flatMap((s) => (s ? [s.name] : [])))];
  const whole = problems.find((_, i) => scopes[i] === null);
  const rerun = step(whole ?? (problems[0] as OpenProblem));
  if (names.length < 2) {
    // one package or suite (or none): its own words
    const named = problems.find((_, i) => scopes[i] !== null) ?? (problems[0] as OpenProblem);
    return { ...single(named), rerun: step(named), problems };
  }
  const noun = scopes.every((s) => s === null || s.kind === 'package') ? 'packages' : 'suites';
  const list = `${names.length} ${noun}: ${joinAnd(names)}`;
  return {
    now: `Tests fail in ${list}`,
    still: `tests still fail in ${list}`,
    action: `make the tests pass in ${joinAnd(names)}`,
    rerun,
    problems,
  };
}

function formatGroup(problems: OpenProblem[]): ProblemGroup {
  const files = [
    ...new Set(problems.flatMap((p) => (p.command === null ? [] : commandFiles(p.command)))),
  ].filter((f) => f !== '.');
  if (files.length === 0) return { ...single(problems[0] as OpenProblem), problems };
  const n = files.length;
  const what = n === 1 ? '1 file needs' : `${n} files need`;
  return {
    now: `${what} formatting`,
    still: `${n === 1 ? '1 file still needs' : `${n} files still need`} formatting`,
    action: n === 1 ? 'format the file' : `format the ${n} files`,
    rerun: step(problems[0] as OpenProblem),
    problems,
  };
}

// Groups, in the order their newest problem appears (open problems are newest first).
export function groupProblems(problems: OpenProblem[]): ProblemGroup[] {
  const keyed = new Map<string, OpenProblem[]>();
  for (const p of problems) {
    const category = categoryOf(p);
    const key =
      p.isTest || category === 'test'
        ? 'tests'
        : category === 'format'
          ? 'format'
          : `words:${describeFailure(p.command, p.error).now}`;
    keyed.set(key, [...(keyed.get(key) ?? []), p]);
  }
  return [...keyed].map(([key, members]) =>
    key === 'tests'
      ? testGroup(members)
      : key === 'format'
        ? formatGroup(members)
        : { ...single(members[0] as OpenProblem), problems: members },
  );
}
