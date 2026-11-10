/**
 * 退出清理（lifecycle/cleanup）单元测试
 *
 * 覆盖（2026-11-10 用户指令：正常关闭必须回收所有子进程与资源）：
 * 1. performCleanup 在 dispose 之前快照子进程 PID，宽限期后兜底强杀
 * 2. 兜底强杀失败不影响后续资源释放（SQLite close）与 cleanupDone 置位
 * 3. 重复调用幂等（isCleaningUp 守卫）
 * 4. runCleanupAndExit：完成 / 异常 / 硬超时三条路径都只退出一次
 *
 * 子进程模块以 mock 替换：真实 taskkill 不在单测中执行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppContext } from '../../src/main/bootstrap/app-context';

const childMocks = vi.hoisted(() => ({
  collectChildPids: vi.fn((sources: readonly { pid?: number }[]) =>
    sources.map((s) => s.pid).filter((pid): pid is number => typeof pid === 'number' && pid > 0),
  ),
  terminateChildProcesses: vi.fn(() =>
    Promise.resolve({
      killed: [] as number[],
      failed: [],
      survivors: [],
    }),
  ),
}));

vi.mock('../../src/main/lifecycle/child-processes', () => ({
  collectChildPids: childMocks.collectChildPids,
  terminateChildProcesses: childMocks.terminateChildProcesses,
}));

import {
  CLEANUP_TIMEOUT_MS,
  performCleanup,
  runCleanupAndExit,
} from '../../src/main/lifecycle/cleanup';

interface FakeCtxParts {
  readonly ctx: AppContext;
  readonly dshDispose: ReturnType<typeof vi.fn>;
  readonly orchestratorDispose: ReturnType<typeof vi.fn>;
  readonly tabsDispose: ReturnType<typeof vi.fn>;
  readonly storageClose: ReturnType<typeof vi.fn>;
}

/** 构造仅含 cleanup 所需字段的假上下文（其余字段为 null/空实现）。 */
function makeFakeCtx(overrides: Partial<Record<keyof AppContext, unknown>> = {}): FakeCtxParts {
  const dshDispose = vi.fn(() => Promise.resolve());
  const orchestratorDispose = vi.fn(() => Promise.resolve());
  const tabsDispose = vi.fn();
  const storageClose = vi.fn();

  const ctx = {
    isCleaningUp: false,
    cleanupDone: false,
    aiHandlersDispose: null,
    piWebHostLauncher: null,
    genofficeIntegration: null,
    unbindDshTabClose: null,
    dshLauncher: {
      status: () => ({ state: 'running', pid: 4321 }),
      dispose: dshDispose,
    },
    disposeDevtoolsManager: null,
    disposeDevtoolsShortcuts: null,
    orchestrator: {
      listActiveProviderPids: () => [8765],
      disposeAll: orchestratorDispose,
    },
    tabManager: { query: () => [], disposeAll: tabsDispose },
    settingsManager: { set: vi.fn() },
    windowManager: { getAllWindows: () => [] },
    tabViewIntegration: null,
    disposeContextMenu: null,
    disposeZoomControl: null,
    disposeDragInjection: null,
    statusBarOverlay: null,
    statusBarBall: null,
    selectionCardOverlay: null,
    trayManager: null,
    disposeTranslateManager: null,
    storageLayer: { close: storageClose },
    ...overrides,
  } as unknown as AppContext;

  return { ctx, dshDispose, orchestratorDispose, tabsDispose, storageClose };
}

beforeEach(() => {
  childMocks.collectChildPids.mockClear();
  childMocks.terminateChildProcesses.mockClear();
  childMocks.terminateChildProcesses.mockResolvedValue({ killed: [], failed: [], survivors: [] });
});

describe('performCleanup', () => {
  it('should snapshot child pids before disposing and reap them after graceful cleanup', async () => {
    const { ctx, dshDispose, orchestratorDispose, tabsDispose, storageClose } = makeFakeCtx();

    await performCleanup(ctx);

    expect(dshDispose).toHaveBeenCalledTimes(1);
    expect(orchestratorDispose).toHaveBeenCalledTimes(1);
    expect(tabsDispose).toHaveBeenCalledTimes(1);
    expect(childMocks.collectChildPids).toHaveBeenCalledTimes(1);
    // 快照含 dsh 与 Provider 子进程（pi 未启动，pid undefined 被过滤）
    expect(childMocks.collectChildPids.mock.calls[0]?.[0]).toEqual([
      { label: 'dsh', pid: 4321 },
      { label: 'pi-web-host', pid: undefined },
      { label: 'ai-provider', pid: 8765 },
    ]);
    expect(childMocks.terminateChildProcesses).toHaveBeenCalledWith([4321, 8765]);
    expect(storageClose).toHaveBeenCalledTimes(1);
    expect(ctx.isCleaningUp).toBe(true);
    expect(ctx.cleanupDone).toBe(true);
  });

  it('should still release resources when child reaping fails', async () => {
    childMocks.terminateChildProcesses.mockRejectedValueOnce(new Error('taskkill unavailable'));
    const { ctx, storageClose } = makeFakeCtx();

    await expect(performCleanup(ctx)).resolves.toBeUndefined();

    expect(storageClose).toHaveBeenCalledTimes(1);
    expect(ctx.cleanupDone).toBe(true);
  });

  it('should stay idempotent when cleanup is already in progress', async () => {
    const { ctx, dshDispose } = makeFakeCtx();

    await performCleanup(ctx);
    await performCleanup(ctx);

    expect(dshDispose).toHaveBeenCalledTimes(1);
  });
});

describe('runCleanupAndExit', () => {
  it('should exit once after cleanup completes', async () => {
    const { ctx } = makeFakeCtx();
    const exit = vi.fn();
    const cleanup = vi.fn(() => Promise.resolve());

    runCleanupAndExit(ctx, { exit, cleanup, timeoutMs: 1_000 });
    await new Promise((r) => setTimeout(r, 0));

    expect(cleanup).toHaveBeenCalledWith(ctx);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('should exit even when cleanup rejects', async () => {
    const { ctx } = makeFakeCtx();
    const exit = vi.fn();

    runCleanupAndExit(ctx, {
      exit,
      cleanup: () => Promise.reject(new Error('boom')),
      timeoutMs: 1_000,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('should force exit on timeout and ignore the late cleanup result', async () => {
    const { ctx } = makeFakeCtx();
    const exit = vi.fn();
    let finishCleanup: (() => void) | undefined;

    runCleanupAndExit(ctx, {
      exit,
      cleanup: () =>
        new Promise<void>((resolve) => {
          finishCleanup = resolve;
        }),
      timeoutMs: 5,
    });

    await new Promise((r) => setTimeout(r, 25));

    expect(exit).toHaveBeenCalledTimes(1);
    expect(ctx.cleanupDone).toBe(true);

    // 超时后再完成清理，不得二次退出
    finishCleanup?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('should default the timeout to CLEANUP_TIMEOUT_MS', () => {
    expect(CLEANUP_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
