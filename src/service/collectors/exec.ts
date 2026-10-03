import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const EXEC_TIMEOUT_MS = 3_000;

export type ExecResult =
  | { ok: true; stdout: string }
  | { ok: false; missing: boolean };

/**
 * Runs one of `commands` (absolute paths first, bare name last) without a shell.
 * The service gets a minimal PATH from the host, so system tools are tried at
 * their usual absolute locations before PATH lookup.
 */
export const run = async (
  commands: string[],
  args: string[],
  timeout = EXEC_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecResult> => {
  for (const command of commands) {
    const result = await new Promise<ExecResult>((resolve) => {
      execFile(command, args, { timeout, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (!error) {
          resolve({ ok: true, stdout });
          return;
        }
        resolve({ ok: false, missing: 'code' in error && error.code === 'ENOENT' });
      });
    });
    // Only a missing binary moves on to the next candidate; a failing one is the answer.
    if (result.ok || !result.missing) return result;
  }
  return { ok: false, missing: true };
};

export const readText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};
