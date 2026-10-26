import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { Config } from '../core/config.ts';
import { normalizeCommand } from '../model/event.ts';

// config.ignore.projects / ignore.commands (P10), shared by every collector.
// Globs: `*` (within one folder name for paths, anything for commands), `**`
// (anything), `?`, and a leading `~` for the home folder. Written by hand: no
// dependency, and Node's own path.matchesGlob is experimental (it can print a
// warning, which hooks must never do).

export interface Ignore {
  // True when the folder or any folder above it matches, so ignoring ~/secret
  // also ignores ~/secret/app/src.
  isIgnoredProject(path: string): boolean;
  isIgnoredCommand(command: string): boolean;
}

function globToRegExp(glob: string, pathMode: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += pathMode ? '[^/]*' : '.*';
    } else if (c === '?') {
      re += pathMode ? '[^/]' : '.';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const expandHome = (g: string) => (g === '~' || g.startsWith('~/') ? homedir() + g.slice(1) : g);

export function compileIgnore(config: Config): Ignore {
  const projects = config.ignore.projects.map((g) => globToRegExp(resolve(expandHome(g)), true));
  const commands = config.ignore.commands.map((g) => globToRegExp(g, false));
  return {
    isIgnoredProject(path) {
      if (projects.length === 0) return false;
      for (let dir = path; ; dir = dirname(dir)) {
        if (projects.some((g) => g.test(dir))) return true;
        if (dirname(dir) === dir) return false;
      }
    },
    isIgnoredCommand(command) {
      if (commands.length === 0) return false;
      const normalized = normalizeCommand(command);
      return commands.some((g) => g.test(normalized));
    },
  };
}
