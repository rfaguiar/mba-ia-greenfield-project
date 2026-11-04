import {
  runProcess,
  ProcessExitError,
  ProcessTimeoutError,
} from './run-process';

describe('runProcess', () => {
  it('captures bounded stdout from an argument-vector process', async () => {
    await expect(
      runProcess(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', 'safe;argument'],
        { timeoutMs: 1000 },
      ),
    ).resolves.toBe('safe;argument');
  });

  it('maps a non-zero exit code to ProcessExitError', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'process.exit(4)'], {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject<Partial<ProcessExitError>>({
      exitCode: 4,
    });
  });

  it('kills a process that exceeds its timeout', async () => {
    await expect(
      runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        timeoutMs: 50,
      }),
    ).rejects.toBeInstanceOf(ProcessTimeoutError);
  });

  it('kills a process when its signal is aborted', async () => {
    const controller = new AbortController();
    const execution = runProcess(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      { timeoutMs: 5000, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await expect(execution).rejects.toBeInstanceOf(ProcessTimeoutError);
  });
});
