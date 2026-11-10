/**
 * 退出子进程兜底回收（lifecycle/child-processes）单元测试
 *
 * 覆盖（2026-11-10 用户指令：正常关闭必须彻底回收子进程）：
 * 1. collectChildPids：非法值 / 本进程 / 重复 PID 过滤
 * 2. terminateChildProcesses：已退出直接记为 killed、存活 PID 强杀、失败隔离
 * 3. 强杀后的存活性复核（轮询到消失 / 超时后报告幸存者）
 * 4. createDefaultForceKill：Windows taskkill /T /F（含中文 not-found 幂等）
 *    与 POSIX SIGKILL —— 通过注入 execFile 替身，单测不真的执行系统命令
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  collectChildPids,
  createDefaultForceKill,
  terminateChildProcesses,
  type ExecFileLike,
} from '../../src/main/lifecycle/child-processes';

/** taskkill 替身：记录入参并按预设结果回调。 */
function makeExecFileStub(error: Error | null = null) {
  const calls: { file: string; args: readonly string[]; options: unknown }[] = [];
  const fn: ExecFileLike = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error);
  };
  return { fn, calls };
}

describe('collectChildPids', () => {
  it('should drop invalid, self and duplicate pids while keeping order', () => {
    expect(
      collectChildPids(
        [
          { label: 'dsh', pid: 4321 },
          { label: 'invalid-zero', pid: 0 },
          { label: 'invalid-negative', pid: -1 },
          { label: 'invalid-float', pid: 12.5 },
          { label: 'missing', pid: undefined },
          { label: 'self', pid: 999 },
          { label: 'duplicate', pid: 4321 },
          { label: 'provider', pid: 8765 },
        ],
        999,
      ),
    ).toEqual([4321, 8765]);
  });

  it('should default self pid to the current process', () => {
    expect(collectChildPids([{ label: 'self', pid: process.pid }])).toEqual([]);
  });
});

describe('terminateChildProcesses', () => {
  it('should record already-dead pids without invoking force kill', async () => {
    const forceKillFn = vi.fn(() => Promise.resolve());

    const result = await terminateChildProcesses([101], {
      isAliveFn: () => false,
      forceKillFn,
      waitFn: () => Promise.resolve(),
    });

    expect(forceKillFn).not.toHaveBeenCalled();
    expect(result).toEqual({ killed: [101], failed: [], survivors: [] });
  });

  it('should force kill alive pids and confirm they are gone', async () => {
    const alive = new Set([101, 202]);
    const forceKillFn = vi.fn((pid: number) => {
      alive.delete(pid);
      return Promise.resolve();
    });

    const result = await terminateChildProcesses([101, 202, 101], {
      isAliveFn: (pid) => alive.has(pid),
      forceKillFn,
      waitFn: () => Promise.resolve(),
      verifyTimeoutMs: 100,
    });

    expect(forceKillFn).toHaveBeenCalledTimes(2);
    expect(result.killed).toEqual([101, 202]);
    expect(result.failed).toEqual([]);
    expect(result.survivors).toEqual([]);
  });

  it('should isolate a force-kill failure and still process the rest', async () => {
    const alive = new Set([303, 404]);
    const forceKillFn = vi.fn((pid: number) => {
      if (pid === 303) throw new Error('access denied');
      alive.delete(pid);
      return Promise.resolve();
    });

    const result = await terminateChildProcesses([303, 404], {
      isAliveFn: (pid) => alive.has(pid),
      forceKillFn,
      waitFn: () => Promise.resolve(),
      verifyTimeoutMs: 0,
    });

    expect(result.killed).toEqual([404]);
    expect(result.failed).toEqual([{ pid: 303, error: 'access denied' }]);
    expect(result.survivors).toEqual([303]);
  });

  it('should poll until the process disappears', async () => {
    let aliveChecks = 0;
    const waitFn = vi.fn(() => Promise.resolve());

    const result = await terminateChildProcesses([505], {
      // 首次探测存活 → 强杀后第一次复核仍存活 → 第二次复核消失
      isAliveFn: () => {
        aliveChecks += 1;
        return aliveChecks <= 2;
      },
      forceKillFn: () => Promise.resolve(),
      waitFn,
      verifyTimeoutMs: 1_000,
      pollIntervalMs: 1,
    });

    expect(waitFn).toHaveBeenCalled();
    expect(result.survivors).toEqual([]);
  });
});

describe('createDefaultForceKill', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should terminate the whole process tree via taskkill on Windows', async () => {
    const stub = makeExecFileStub();

    await createDefaultForceKill('win32', stub.fn)(2468);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toEqual({
      file: 'taskkill',
      args: ['/PID', '2468', '/T', '/F'],
      options: { windowsHide: true },
    });
  });

  it('should treat a missing target (Chinese Windows message) as success', async () => {
    const stub = makeExecFileStub(new Error('错误: 没有运行的任务匹配指定标准。'));

    await expect(createDefaultForceKill('win32', stub.fn)(111)).resolves.toBeUndefined();
  });

  it('should reject other taskkill errors for later survivor reporting', async () => {
    const stub = makeExecFileStub(new Error('拒绝访问'));

    await expect(createDefaultForceKill('win32', stub.fn)(222)).rejects.toThrow('拒绝访问');
  });

  it('should use SIGKILL and stay idempotent off Windows', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await createDefaultForceKill('linux', makeExecFileStub().fn)(333);
    expect(killSpy).toHaveBeenCalledWith(333, 'SIGKILL');

    killSpy.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    await expect(
      createDefaultForceKill('linux', makeExecFileStub().fn)(444),
    ).resolves.toBeUndefined();
  });
});
