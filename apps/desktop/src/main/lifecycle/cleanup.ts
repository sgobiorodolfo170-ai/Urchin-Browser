/**
 * 退出清理流程 · 进程退出前释放所有原生资源
 *
 * 依据：docs/refactor-plan-p2.md §1.1（P2 拆分规划 Session 1 步骤 2）。
 * 从 index.ts 提取：函数体原本闭包引用 index.ts 的模块级 let，Step 1 已把这些
 * 状态收进 AppContext；这里只需显式接收 ctx，不再依赖 index.ts 作用域。
 */
import { createLogger } from '@urchin/logger';
import type { AppContext } from '../bootstrap/app-context';
import { collectChildPids, terminateChildProcesses, type ChildPidSource } from './child-processes';

// 与 index.ts 保持同一 module 名，日志输出与拆分前完全一致。
const log = createLogger('main');

/**
 * 清理硬超时（2026-11-10 用户指令：关闭必须彻底退出、不得残留/挂死）。
 *
 * 正常清理通常 < 300ms；10s 只是异常兜底——任一子进程 kill 或 SQLite close
 * 挂死时，到点仍强制 app.exit(0)，杜绝「窗口没了但进程还在」。
 */
export const CLEANUP_TIMEOUT_MS = 10_000;

/**
 * 在进入任何 dispose 之前快照子进程 PID（2026-11-10）。
 *
 * 为什么必须先快照：disposeHost / killChild 会先清空启动器内部引用再执行
 * taskkill，之后 status().pid 已为空；若在 dispose 之后取，就再也拿不到
 * 「该被回收但没死」的 PID。快照失败（启动早期清理、字段未初始化）按空处理，
 * 不得让兜底逻辑本身打断退出流程。
 */
function snapshotChildPids(ctx: AppContext): number[] {
  const sources: ChildPidSource[] = [];
  try {
    sources.push({ label: 'dsh', pid: ctx.dshLauncher?.status().pid });
  } catch {
    /* 启动早期未初始化：忽略 */
  }
  try {
    sources.push({ label: 'pi-web-host', pid: ctx.piWebHostLauncher?.status().pid });
  } catch {
    /* 同上 */
  }
  try {
    for (const pid of ctx.orchestrator?.listActiveProviderPids() ?? []) {
      sources.push({ label: 'ai-provider', pid });
    }
  } catch {
    /* 同上 */
  }
  return collectChildPids(sources);
}

/**
 * 退出清理流程：在进程退出前释放所有原生资源。
 *
 * 清理顺序（先停止外部 I/O，再关闭本地句柄）：
 * 1. ctx.orchestrator.disposeAll()：kill 所有 Provider utility process，清理心跳/空闲定时器，关闭 MessagePort
 * 2. ctx.tabManager.disposeAll()：显式 destroy 所有 tab 的 webContents（释放渲染进程线程 + GPU）
 * 3. ctx.windowManager：destroy 所有 BrowserWindow
 * 4. ctx.tabViewIntegration.dispose()：清理 tab 事件节流定时器
 * 5. 等待短暂宽限期让 utility process 实际退出（kill 信号异步生效）
 * 6. ctx.storageLayer.close()：关闭所有 better-sqlite3 连接（main / ai / 命名空间连接池），触发 WAL checkpoint
 *
 * 设计要点：
 * - 异步执行并 await disposeAll，确保子进程 kill 信号发出后再继续
 * - 使用 ctx.isCleaningUp + ctx.cleanupDone 双标志位处理 before-quit 重入
 * - 清理完成后由调用方 app.exit(0) 真正退出
 */
export async function performCleanup(ctx: AppContext): Promise<void> {
  if (ctx.isCleaningUp) return;
  ctx.isCleaningUp = true;
  // 0.01 快照子进程 PID：dispose 会清空引用，必须在任何 dispose 之前取（见 snapshotChildPids）。
  const childPids = snapshotChildPids(ctx);
  try {
    // 0. abort 所有活跃 AI 流（chat + agent）
    //    必须在 ctx.orchestrator.disposeAll 之前调用：先 abort 流间接触发 stream.ts / pi-event-bridge.ts
    //    的 cleanup()，释放 listener 和 rendererPort；再 disposeAll kill 子进程。
    //    若先 kill 子进程，stream 会因 port 断开间接终止，但 cleanup() 不会被调用，listener 泄漏。
    if (ctx.aiHandlersDispose) {
      try {
        ctx.aiHandlersDispose();
      } catch (e) {
        log.error('Failed to dispose AI handlers on quit', { error: String(e) });
      }
      ctx.aiHandlersDispose = null;
    }

    // 0.52 终止 pi 阶段 2 托管服务 utility 子进程（ADR-014：常驻服务随应用退出终止）
    if (ctx.piWebHostLauncher) {
      try {
        await ctx.piWebHostLauncher.dispose();
      } catch (e) {
        log.error('Failed to dispose piWebHost launcher on quit', { error: String(e) });
      }
      ctx.piWebHostLauncher = null;
    }

    // 0.55 停 GenOffice Rust sidecar 子进程（dev.109 上游 shell 的 before-quit 对应钩子；
    //      Windows 上父进程退出不自动杀 spawn 子进程，不显式停会遗留 xlsx-sidecar.exe）
    if (ctx.genofficeIntegration) {
      try {
        ctx.genofficeIntegration.stopProcesses();
      } catch (e) {
        log.error('Failed to stop genoffice sidecar on quit', { error: String(e) });
      }
    }

    // 0.6 终止 DeepSeek Harness 子进程树 + 解绑标签关闭监听
    ctx.unbindDshTabClose?.();
    ctx.unbindDshTabClose = null;
    if (ctx.dshLauncher) {
      try {
        await ctx.dshLauncher.dispose();
      } catch (e) {
        log.error('Failed to dispose dsh launcher on quit', { error: String(e) });
      }
      ctx.dshLauncher = null;
    }

    // 0.65 卸载 DevTools 管理器（CDP 会话清理）+ F12 快捷键监听——dev.121
    if (ctx.disposeDevtoolsManager) {
      try {
        ctx.disposeDevtoolsManager();
      } catch (e) {
        log.error('Failed to dispose devtools manager on quit', { error: String(e) });
      }
      ctx.disposeDevtoolsManager = null;
    }
    if (ctx.disposeDevtoolsShortcuts) {
      try {
        ctx.disposeDevtoolsShortcuts();
      } catch (e) {
        log.error('Failed to dispose devtools shortcuts on quit', { error: String(e) });
      }
      ctx.disposeDevtoolsShortcuts = null;
    }

    // 1. 清理 AI Provider 子进程（utility process）+ 定时器 + MessagePort
    if (ctx.orchestrator) {
      try {
        // await 确保 disposeAll 内所有 kill/postMessage/port.close 同步执行完毕
        await ctx.orchestrator.disposeAll();
      } catch (e) {
        log.error('Failed to dispose orchestrator on quit', { error: String(e) });
      }
    }

    // 1.5. 标签持久化（TP4）：退出前保存全部工作区标签快照到 Settings。
    //     始终保存（不受 startup.restoreTabs 开关影响——其他工作区懒恢复需要此数据）。
    //     过滤掉总览页和 GenOffice 编辑器（瞬态视图/需预构建视图，不可恢复）。
    try {
      const tabSnapshots = ctx.tabManager
        .query({})
        .filter(
          (t) =>
            !t.url.startsWith('urchin://workspaces') && !t.url.startsWith('urchin://genoffice'),
        )
        .map((t) => ({
          url: t.url,
          title: t.title,
          workspaceId: t.workspaceId,
          active: t.active,
        }));
      ctx.settingsManager.set('session.lastTabs', tabSnapshots);
      log.info('tab session persisted', { count: tabSnapshots.length });
    } catch (e) {
      log.error('Failed to persist tab session', { error: String(e) });
    }

    // 2. 显式销毁所有 tab 的 webContents（BrowserView webContents 不会随 window 自动回收）
    try {
      ctx.tabManager.disposeAll();
    } catch (e) {
      log.error('Failed to dispose tabs on quit', { error: String(e) });
    }

    // 3. 销毁所有 BrowserWindow
    try {
      for (const win of ctx.windowManager.getAllWindows()) {
        if (!win.browserWindow.isDestroyed()) {
          win.browserWindow.destroy();
        }
      }
    } catch (e) {
      log.error('Failed to destroy windows on quit', { error: String(e) });
    }

    // 4. 清理 tab 集成的节流定时器（view-integration.ts 的 updatedThrottleTimer）
    if (ctx.tabViewIntegration) {
      try {
        ctx.tabViewIntegration.dispose();
      } catch (e) {
        log.error('Failed to dispose tabViewIntegration on quit', { error: String(e) });
      }
      ctx.tabViewIntegration = null;
    }

    // 4.5 移除右键菜单的 created 监听（webContents 的 context-menu 监听随 destroy 释放）
    if (ctx.disposeContextMenu) {
      try {
        ctx.disposeContextMenu();
      } catch (e) {
        log.error('Failed to dispose context menu on quit', { error: String(e) });
      }
      ctx.disposeContextMenu = null;
    }

    // 4.6 移除 Ctrl+滚轮缩放的 created 监听（webContents 的 before-input-event 随 destroy 释放）
    if (ctx.disposeZoomControl) {
      try {
        ctx.disposeZoomControl();
      } catch (e) {
        log.error('Failed to dispose zoom control on quit', { error: String(e) });
      }
      ctx.disposeZoomControl = null;
    }

    // 4.6a 移除中转区拖拽注入的 created/did-finish-load 监听
    if (ctx.disposeDragInjection) {
      try {
        ctx.disposeDragInjection();
      } catch (e) {
        log.error('Failed to dispose drag injection on quit', { error: String(e) });
      }
      ctx.disposeDragInjection = null;
    }

    // 4.6.1 销毁底部悬浮状态栏子窗口（不受 WindowManager 管理，需显式释放）
    if (ctx.statusBarOverlay) {
      try {
        ctx.statusBarOverlay.destroy();
      } catch (e) {
        log.error('Failed to dispose status bar overlay on quit', { error: String(e) });
      }
      ctx.statusBarOverlay = null;
    }
    if (ctx.statusBarBall) {
      try {
        ctx.statusBarBall.destroy();
      } catch (e) {
        log.error('Failed to dispose status bar ball on quit', { error: String(e) });
      }
      ctx.statusBarBall = null;
    }

    // 4.6.2 销毁划词翻译结果卡子窗口（同属状态栏悬浮窗家族，不受 WindowManager 管理）
    if (ctx.selectionCardOverlay) {
      try {
        ctx.selectionCardOverlay.destroy();
      } catch (e) {
        log.error('Failed to dispose selection card overlay on quit', { error: String(e) });
      }
      ctx.selectionCardOverlay = null;
    }

    // 4.6.3 销毁系统托盘图标并解绑窗口 close 监听（托盘驻留功能，2026-11-10）
    if (ctx.trayManager) {
      try {
        ctx.trayManager.dispose();
      } catch (e) {
        log.error('Failed to dispose tray manager on quit', { error: String(e) });
      }
      ctx.trayManager = null;
    }

    // 4.9 网页翻译管理器清理（dev.79）：停 pending 轮询、移除 did-finish-load 钩子、清每 tab 状态
    if (ctx.disposeTranslateManager) {
      try {
        ctx.disposeTranslateManager();
      } catch (e) {
        log.error('Failed to dispose translate manager on quit', { error: String(e) });
      }
      ctx.disposeTranslateManager = null;
    }

    // 5. 宽限期：utility process 的 kill 信号已发出但进程实际退出需要短暂时间，
    //    等待 150ms 让子进程完成退出，避免主进程先退导致子进程残留
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    // 5.1 兜底强杀：优雅 dispose 是「尽力而为」，此处按启动时快照的 PID
    //     逐棵进程树强杀并复核。覆盖三类真实残留场景——
    //     ① dispose 抛错/被 catch 后流程继续；② kill 信号异步未生效；
    //     ③ dsh 的 node.exe 派生出孙进程。幸存者只记日志，不阻塞退出。
    if (childPids.length > 0) {
      try {
        const reaped = await terminateChildProcesses(childPids);
        log.info('child process reaping finished', {
          pids: childPids,
          killed: reaped.killed,
          failed: reaped.failed,
        });
        if (reaped.survivors.length > 0) {
          log.error('child processes survived termination', { pids: reaped.survivors });
        }
      } catch (e) {
        log.error('child process reaping failed', { error: String(e) });
      }
    }

    // 6. 关闭 SQLite 数据库连接（释放 better-sqlite3 原生线程，触发 WAL checkpoint）
    if (ctx.storageLayer) {
      try {
        ctx.storageLayer.close();
      } catch (e) {
        log.error('Failed to close storageLayer on quit', { error: String(e) });
      }
      ctx.storageLayer = null;
    }

    ctx.cleanupDone = true;
    log.info('cleanup completed, exiting process');
  } catch (e) {
    log.error('Unexpected error during cleanup', { error: String(e) });
    ctx.cleanupDone = true;
  }
}

/** runCleanupAndExit 的可注入依赖（单测用）。 */
export interface CleanupAndExitDeps {
  /** 真正退出的动作（主进程传 app.exit） */
  readonly exit: (code: number) => void;
  /** 清理实现（默认 performCleanup；单测注入假实现） */
  readonly cleanup?: (ctx: AppContext) => Promise<void>;
  /** 硬超时（默认 CLEANUP_TIMEOUT_MS） */
  readonly timeoutMs?: number;
  readonly setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * 执行清理并在完成后退出；超时或清理异常也必须退出（2026-11-10）。
 *
 * 为什么需要本函数：调用方原先直接 `performCleanup(ctx).then(() => app.exit(0))`，
 * 一旦清理内部出现未决 await（如 taskkill 不回调、SQLite close 挂起），进程
 * 就永远停在「窗口已关、进程还在」的状态。这里把「完成 / 抛错 / 超时」三条
 * 路径统一收敛到一次 exit，且用 settled 保证只退出一次。
 */
/** 安全转字符串：unknown 可能是对象（避免 no-base-to-string 的 [object Object]）。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

export function runCleanupAndExit(ctx: AppContext, deps: CleanupAndExitDeps): void {
  const cleanup = deps.cleanup ?? performCleanup;
  const timeoutMs = deps.timeoutMs ?? CLEANUP_TIMEOUT_MS;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let settled = false;
  const timerRef: { handle?: ReturnType<typeof setTimeout> } = {};

  const finish = (timedOut: boolean, error?: unknown): void => {
    if (settled) return;
    settled = true;
    if (timerRef.handle !== undefined) clearTimer(timerRef.handle);
    if (timedOut) {
      // 超时后不再等待清理收尾——但标记 cleanupDone，使 before-quit 重入时放行。
      log.error('cleanup timed out — forcing exit', { timeoutMs });
      ctx.cleanupDone = true;
    } else if (error !== undefined) {
      log.error('cleanup failed — forcing exit', { error: errorText(error) });
    }
    deps.exit(0);
  };

  timerRef.handle = setTimer(() => finish(true), timeoutMs);
  // 不让兜底定时器单独撑住事件循环（进程能因其它原因自然退出时不必等满 10s）
  (timerRef.handle as { unref?: () => void }).unref?.();

  void cleanup(ctx)
    .then(() => finish(false))
    .catch((e: unknown) => finish(false, e));
}
