import { finishProcessExit } from '../../src/main/lifecycle/exit-process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeManagedApplication } from '../e2e/helpers/close-electron';
import { installLaunchHealth } from '../../src/main/bootstrap/launch-health';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

afterEach(() => vi.useRealTimers());
describe('外部应用回收', () => {
  it('forces only the recorded PID when close never returns', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn().mockResolvedValue(undefined);
    const app = {
      close: () => new Promise<void>(() => undefined),
      process: () => ({ pid: 123, exitCode: null, signalCode: null }),
    };
    const cleanup = closeManagedApplication(app, terminate, 50);
    await vi.advanceTimersByTimeAsync(50);
    await cleanup;
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(123);
  });
  it('does not kill an already exited process or a reused PID', async () => {
    const close = vi.fn();
    const terminate = vi.fn();
    await closeManagedApplication(
      { close, process: () => ({ pid: 123, exitCode: 0, signalCode: null }) },
      terminate,
    );
    expect(close).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });
  it('does not force kill after a normal close', async () => {
    const terminate = vi.fn();
    await closeManagedApplication(
      {
        close: () => Promise.resolve(),
        process: () => ({ pid: 123, exitCode: null, signalCode: null }),
      },
      terminate,
    );
    expect(terminate).not.toHaveBeenCalled();
  });
  it('reclaims a failed close', async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    await closeManagedApplication(
      {
        close: () => Promise.reject(new Error('native hang')),
        process: () => ({ pid: 123, exitCode: null, signalCode: null }),
      },
      terminate,
    );
    expect(terminate).toHaveBeenCalledWith(123);
  });
});
describe('启动就绪心跳', () => {
  it('writes a PID receipt only when installed and updates it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'urchin-health-test-'));
    const file = join(dir, 'ready.json');
    const dispose = installLaunchHealth(file);
    try {
      await vi.waitFor(async () => {
        const record = JSON.parse(await readFile(file, 'utf8')) as {
          pid: number;
          updatedAt: number;
        };
        expect(record.pid).toBe(process.pid);
        expect(record.updatedAt).toBeGreaterThan(0);
      });
    } finally {
      dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('隔离退出兼容模式', () => {
  it('bypasses DLL detach only for an explicitly isolated Windows process', () => {
    const terminate = vi.fn();
    const normalExit = vi.fn();
    const env = {
      URCHIN_NATIVE_EXIT_GUARD: '1',
      URCHIN_TEST_USER_DATA: 'test-user',
      URCHIN_TEST_DATA_DIR: 'test-data',
    };
    finishProcessExit(0, normalExit, { platform: 'win32', env, terminate });
    expect(terminate).toHaveBeenCalledOnce();
    expect(normalExit).not.toHaveBeenCalled();
  });
  it('keeps the installed and non-Windows exit paths unchanged', () => {
    const terminate = vi.fn();
    const normalExit = vi.fn();
    finishProcessExit(0, normalExit, {
      platform: 'win32',
      env: { URCHIN_NATIVE_EXIT_GUARD: '1' },
      terminate,
    });
    finishProcessExit(0, normalExit, { platform: 'linux', env: {}, terminate });
    expect(normalExit).toHaveBeenCalledTimes(2);
    expect(terminate).not.toHaveBeenCalled();
  });
});
