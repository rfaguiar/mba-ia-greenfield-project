import { spawn } from 'node:child_process';

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 16 * 1024;

export interface RunProcessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export class ProcessTimeoutError extends Error {
  constructor() {
    super('Media process timed out or was aborted');
    this.name = ProcessTimeoutError.name;
  }
}

export class ProcessExitError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly stderrTail: string,
    message = 'Media process exited unsuccessfully',
  ) {
    super(message);
    this.name = ProcessExitError.name;
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new ProcessTimeoutError());
      return;
    }

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill('SIGKILL');
      reject(error);
    };
    const onAbort = () => fail(new ProcessTimeoutError());
    const timer = setTimeout(
      () => fail(new ProcessTimeoutError()),
      options.timeoutMs,
    );
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        fail(
          new ProcessExitError(
            null,
            stderrTail.toString('utf8'),
            'Media process output exceeded its limit',
          ),
        );
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(
        -MAX_STDERR_TAIL_BYTES,
      );
    });

    child.once('error', (error) => {
      fail(
        new ProcessExitError(null, stderrTail.toString('utf8'), error.message),
      );
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(new ProcessExitError(code, stderrTail.toString('utf8')));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
