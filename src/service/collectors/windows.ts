import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { run, type ExecResult } from './exec.ts';

const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';

export const POWERSHELL = [`${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, 'powershell.exe'];
export const NVIDIA_SMI_WIN32 = ['nvidia-smi.exe', `${systemRoot}\\System32\\nvidia-smi.exe`];

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/**
 * OpenChamber starts services with a minimal environment that has no
 * `PSModulePath`. Windows PowerShell then hangs before running anything, even
 * `Write-Output 1`. Measured on a GitHub Windows runner: unset or set to the
 * system module folder it hangs; empty it starts in under a second and still
 * loads the CIM cmdlets.
 */
export const powerShellEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const hasModulePath = Object.keys(source).some((name) => name.toUpperCase() === 'PSMODULEPATH');
  return hasModulePath ? source : { ...source, PSModulePath: '' };
};

export const runPowerShell = (script: string, timeout?: number): Promise<ExecResult> =>
  run(POWERSHELL, [...POWERSHELL_ARGS, script], timeout, powerShellEnv());

/**
 * Starting PowerShell costs about a second, too slow for a 2 s tick. One
 * long-lived loop prints a JSON line per sample instead. It exits by itself
 * when the service process is gone, so a crash leaves no orphan behind.
 */
const gpuLoopScript = (parentPid: number): string => `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }
  $e = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter "Name LIKE '%engtype_3D'" | Select-Object Name, UtilizationPercentage)
  $m = @(Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory | Select-Object Name, DedicatedUsage, DedicatedLimit, SharedUsage, SharedLimit)
  [Console]::Out.WriteLine((@{ engines = $e; memory = $m } | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
`;

export type LineLoop = {
  /** Latest line, waiting up to `waitMs` for the first one. `missing` when PowerShell is not installed. */
  latest: (waitMs: number) => Promise<{ line: string } | { missing: boolean }>;
  stop: () => void;
};

export const createGpuLoop = (): LineLoop => {
  let child: ChildProcess | null = null;
  let line: string | null = null;
  let missing = false;
  let waiters: (() => void)[] = [];

  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const start = (candidates: string[]) => {
    const [command, ...rest] = candidates;
    if (!command) {
      missing = true;
      wake();
      return;
    }
    const proc = spawn(command, [...POWERSHELL_ARGS, gpuLoopScript(process.pid)], {
      env: powerShellEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child = proc;
    proc.once('error', (error) => {
      if (child !== proc) return;
      child = null;
      if ('code' in error && error.code === 'ENOENT') start(rest);
      else wake();
    });
    proc.once('exit', () => {
      if (child === proc) child = null;
      wake();
    });
    if (proc.stdout) {
      createInterface({ input: proc.stdout }).on('line', (next) => {
        if (!next.trim().startsWith('{')) return;
        line = next;
        wake();
      });
    }
  };

  return {
    latest: async (waitMs) => {
      if (missing) return { missing: true };
      if (!child) {
        line = null;
        start(POWERSHELL);
      }
      if (line === null) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            waiters = waiters.filter((waiter) => waiter !== done);
            resolve();
          }, waitMs);
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          waiters.push(done);
        });
      }
      if (missing) return { missing: true };
      return line === null ? { missing: false } : { line };
    },
    stop: () => {
      const proc = child;
      child = null;
      line = null;
      proc?.kill();
    },
  };
};
