import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { terminateChildProcess } from './process-termination';

class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | undefined> = [];

  constructor(private readonly mode: 'graceful' | 'forced' | 'stuck') {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.mode === 'graceful' && signal === undefined) {
      setImmediate(() => this.finish('SIGTERM'));
    }
    if (this.mode === 'forced' && signal === 'SIGKILL') {
      setImmediate(() => this.finish('SIGKILL'));
    }
    return true;
  }

  private finish(signal: NodeJS.Signals): void {
    this.signalCode = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
  }
}

test('child termination waits for graceful exit', async () => {
  const proc = new FakeChildProcess('graceful');
  await terminateChildProcess(proc as unknown as ChildProcess, {
    gracefulTimeoutMs: 50,
    forceTimeoutMs: 20,
  });
  assert.deepEqual(proc.signals, [undefined]);
});

test('child termination escalates to SIGKILL after the graceful deadline', async () => {
  const proc = new FakeChildProcess('forced');
  await terminateChildProcess(proc as unknown as ChildProcess, {
    gracefulTimeoutMs: 5,
    forceTimeoutMs: 50,
  });
  assert.deepEqual(proc.signals, [undefined, 'SIGKILL']);
});

test('child termination rejects instead of activating new credentials while a process is alive', async () => {
  const proc = new FakeChildProcess('stuck');
  await assert.rejects(
    terminateChildProcess(proc as unknown as ChildProcess, {
      gracefulTimeoutMs: 5,
      forceTimeoutMs: 5,
    }),
    /did not exit/,
  );
  assert.deepEqual(proc.signals, [undefined, 'SIGKILL']);
});
