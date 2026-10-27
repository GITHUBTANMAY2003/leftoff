import { logError } from '../../core/logger.ts';
import { runInternalIngest } from '../../ingest/background.ts';
import { resolveProject } from '../../model/project.ts';
import { runInternalSummarize } from '../../polish/summarize.ts';

// Hidden commands run by hooks and background jobs: they print nothing and
// always exit 0; errors go to the log.
export async function runInternalSummarizeCommand(project: string): Promise<void> {
  try {
    await runInternalSummarize(resolveProject(project));
  } catch (err) {
    logError('summarize', err);
  }
}

export async function runInternalIngestCommand(): Promise<void> {
  try {
    await runInternalIngest();
  } catch (err) {
    logError('ingest', err);
  }
}
