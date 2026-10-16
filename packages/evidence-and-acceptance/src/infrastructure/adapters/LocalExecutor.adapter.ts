// @generated adapter scaffold — implemented for migration station O3 (evidence copy of the local executor).
/**
 * LocalExecutor implements the evidence context's CommandExecutorPort by
 * spawning the argv array directly (no shell): every argument travels as one
 * argv element. `input` is written to the child's stdin and stdin is then
 * closed; `timeoutMs` kills the child's whole process tree (default 60 s
 * when omitted); an omitted `env` gives the child only the allow-listed
 * host variables, never the full host environment; `maxBufferBytes`
 * caps the captured output and overrunning it is an error, never a silent
 * truncation.
 */

import type {
  CommandExecutorPort,
  CommandRunOptions,
  CommandRunResult,
} from '../../application/ports/out/CommandExecutorPort.out-port.js';
import { runSpawnOutcome } from './spawn-run.js';

export class LocalExecutor implements CommandExecutorPort {
  async run(argv: readonly string[], options?: CommandRunOptions): Promise<CommandRunResult> {
    if (argv.length === 0) {
      return {
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: 'LocalExecutor refuses to run an empty argv',
      };
    }
    const outcome = await runSpawnOutcome(argv[0], argv.slice(1), {
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.env !== undefined ? { env: options.env } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options?.input !== undefined ? { input: options.input } : {}),
      ...(options?.maxBufferBytes !== undefined ? { maxBufferBytes: options.maxBufferBytes } : {}),
    });
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  }
}
