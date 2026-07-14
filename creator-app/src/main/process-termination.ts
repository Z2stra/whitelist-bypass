import type { ChildProcess } from 'child_process';

export interface ProcessTerminationOptions {
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

function hasExited(proc: ChildProcess): boolean {
  return proc.pid == null || proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      proc.removeListener('exit', onExit);
      proc.removeListener('close', onExit);
      proc.removeListener('error', onError);
      resolve(value);
    };
    const onExit = (): void => finish(true);
    const onError = (): void => {
      if (hasExited(proc)) finish(true);
    };
    proc.once('exit', onExit);
    proc.once('close', onExit);
    proc.once('error', onError);
    timer = setTimeout(() => finish(hasExited(proc)), Math.max(0, timeoutMs));
    if (hasExited(proc)) finish(true);
  });
}

function requestKill(proc: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    proc.kill(signal);
  } catch {}
}

export async function terminateChildProcess(
  proc: ChildProcess,
  options: ProcessTerminationOptions = {},
): Promise<void> {
  if (hasExited(proc)) return;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 3000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 1000;

  requestKill(proc);
  if (await waitForExit(proc, gracefulTimeoutMs)) return;

  requestKill(proc, 'SIGKILL');
  if (await waitForExit(proc, forceTimeoutMs)) return;

  throw new Error('Child process did not exit after termination request');
}
