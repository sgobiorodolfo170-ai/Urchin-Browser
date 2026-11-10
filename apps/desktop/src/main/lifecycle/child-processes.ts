/**
 * 子进程兜底回收 · 应用退出时的最后一道进程闸门（2026-11-10 用户指令）
 *
 * 背景：
 * 正常关闭必须回收并终止所有子进程，确保完全退出、不残留后台进程；这与
 * 「托盘模式仅隐藏窗口、进程继续驻留」是两种互斥语义（后者不进入清理流程）。
 *
 * 各启动器自身已有优雅 dispose（orchestrator → Provider utilityProcess；
 * pi-web-host → utilityProcess；dsh → taskkill /T /F；GenOffice → Rust sidecar），
 * 但 dispose 都是「尽力而为」：kill 信号异步生效、单点异常被 catch 后流程继续，
 * 主进程一旦退出，未死透的子进程就会成为后台残留。
 *
 * 本模块在优雅 dispose 之后按 PID 做一次兜底强杀：
 * 1. 退出开始时先快照 PID——dispose 会清空启动器内部引用，事后取不到；
 * 2. 优雅清理 + 短暂宽限期后，对仍存活的 PID 执行进程树强杀；
 * 3. Windows 用 `taskkill /PID <pid> /T /F`（连 node.exe 派生的孙进程一起收），
 *    其余平台用 `SIGKILL`；
 * 4. 以 `process.kill(pid, 0)` 轮询复核，把「强杀失败 / 仍存活」如实上报。
 *
 * 设计理由（AGENTS.md §六 三步自审 / §七.2）：
 * - 全部外部依赖（存活探测 / 强杀 / 等待）均可注入，核心逻辑可在单测中验证；
 * - 不依赖 Electron，退出清理之外（如崩溃看门狗）也能复用；
 * - 对「进程已退出」保持幂等：taskkill / SIGKILL 的 not-found 一律视为成功。
 */
import { execFile } from 'node:child_process';

/** 待回收子进程快照项（label 仅用于日志定位来源）。 */
export interface ChildPidSource {
  readonly label: string;
  readonly pid?: number;
}

/** 进程存活探测（默认 process.kill(pid, 0)）。 */
export type IsAliveFn = (pid: number) => boolean;

/** 强杀单个进程树（默认 win32 taskkill /T /F，其余平台 SIGKILL）。 */
export type ForceKillFn = (pid: number) => Promise<void>;

/** 兜底回收依赖（单测注入）。 */
export interface ChildProcessCleanupDeps {
  /** 平台覆盖（默认 process.platform） */
  readonly platform?: NodeJS.Platform;
  readonly isAliveFn?: IsAliveFn;
  readonly forceKillFn?: ForceKillFn;
  readonly waitFn?: (ms: number) => Promise<void>;
  /** 强杀后等待进程消失的总时长（默认 1000ms） */
  readonly verifyTimeoutMs?: number;
  /** 复核轮询间隔（默认 50ms） */
  readonly pollIntervalMs?: number;
}

/** 兜底回收结果（供退出日志留痕）。 */
export interface ChildProcessTerminationResult {
  /** 已确认退出或强杀指令已成功发出的 PID */
  readonly killed: number[];
  /** 强杀指令本身失败的 PID 与原因 */
  readonly failed: readonly { readonly pid: number; readonly error: string }[];
  /** 复核时仍存活的 PID（极端情况：进程挂死在不可中断状态） */
  readonly survivors: number[];
}

/** 默认存活探测：ESRCH 表示进程已不存在。 */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * taskkill 的「目标不存在」判定。
 *
 * 必须兼容多语言系统消息：英文 "not found" / 中文「找不到」与
 * 「没有运行的任务匹配指定标准」（Windows 10/11 中文版实际文案）。
 * 目标已退出不属于失败——兜底回收要求幂等。
 */
function isTaskkillNotFound(message: string): boolean {
  return /not found|no running|找不到|没有运行的任务/i.test(message);
}

/** taskkill 执行器的最小签名（便于单测注入，避免测试真的调用系统命令）。 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { readonly windowsHide: boolean },
  callback: (err: Error | null) => void,
) => unknown;

/** 默认 taskkill 执行器：node:child_process.execFile 的薄封装。 */
const defaultExecFile: ExecFileLike = (file, args, options, callback) => {
  execFile(file, [...args], options, callback);
};

/**
 * 创建默认强杀实现。
 *
 * Windows：taskkill /PID <pid> /T /F —— /T 终止整棵进程树（覆盖 dsh 的
 * node.exe 及其派生的 loader 子进程）；/F 强制终止。
 * 其余平台：SIGKILL（不可捕获，力度等同 /F）。
 *
 * @param platform 目标平台（默认 process.platform；单测注入）
 * @param execFileFn taskkill 执行器（默认真实 execFile；单测注入）
 */
export function createDefaultForceKill(
  platform: NodeJS.Platform = process.platform,
  execFileFn: ExecFileLike = defaultExecFile,
): ForceKillFn {
  return (pid) => {
    if (platform === 'win32') {
      return new Promise<void>((resolve, reject) => {
        execFileFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
          if (err && !isTaskkillNotFound(String(err.message))) {
            reject(new Error(err.message));
            return;
          }
          resolve();
        });
      });
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出 / 无权限：交给后续存活复核判定，不在此处打断其它 PID 的回收
    }
    return Promise.resolve();
  };
}

/**
 * 收集有效子进程 PID：去重、过滤非法值与本进程 PID。
 *
 * 去重是必要的——同一 utility 进程可能既被启动器记录、又被 Orchestrator 记录。
 */
export function collectChildPids(
  sources: readonly ChildPidSource[],
  selfPid: number = process.pid,
): number[] {
  const seen = new Set<number>();
  const pids: number[] = [];
  for (const source of sources) {
    const pid = source.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    if (pid === selfPid || seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

/**
 * 强杀并复核一批子进程 PID。
 *
 * 顺序：先探测存活（已退出直接记为 killed）→ 强杀 → 轮询等待 → 报告幸存者。
 * 单个 PID 失败不会中断整批回收——退出流程必须走完。
 */
export async function terminateChildProcesses(
  pids: readonly number[],
  deps: ChildProcessCleanupDeps = {},
): Promise<ChildProcessTerminationResult> {
  const isAlive = deps.isAliveFn ?? defaultIsAlive;
  const forceKill = deps.forceKillFn ?? createDefaultForceKill(deps.platform);
  const wait =
    deps.waitFn ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const verifyTimeoutMs = deps.verifyTimeoutMs ?? 1_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 50;

  const unique = collectChildPids(pids.map((pid) => ({ label: 'child', pid })));
  const killed: number[] = [];
  const failed: { pid: number; error: string }[] = [];

  for (const pid of unique) {
    if (!isAlive(pid)) {
      killed.push(pid);
      continue;
    }
    try {
      await forceKill(pid);
      killed.push(pid);
    } catch (e) {
      failed.push({ pid, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 复核：kill/taskkill 返回不代表进程已消失（尤其 taskkill 的异步收尾），
  // 短轮询既避免误报幸存者，也不会无限拖住退出流程。
  const deadline = Date.now() + verifyTimeoutMs;
  let survivors = unique.filter(isAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await wait(pollIntervalMs);
    survivors = survivors.filter(isAlive);
  }

  return { killed, failed, survivors };
}
