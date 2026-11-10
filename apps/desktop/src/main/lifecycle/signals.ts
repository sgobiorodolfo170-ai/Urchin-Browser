/**
 * 信号处理：Ctrl+C (SIGINT) 和 kill 命令 (SIGTERM)。
 * 转发到统一异步清理流程，完成（或硬超时）后再 app.exit()。
 * 注意：Electron 主进程默认不处理 SIGINT/SIGTERM，需显式注册。
 * （refactor-plan-p2 §1.3 步骤 6，自 index.ts 原样迁出；index 在原位置调用
 * installSignalHandlers(ctx)，注册时机与原顶层注册一致。）
 *
 * 2026-11-10：改走 runCleanupAndExit（统一「完成 / 异常 / 10s 超时」三路退出），
 * 并加 isCleaningUp 去重——连续两次 Ctrl+C 不得在第一次清理未收尾时提前 exit。
 */
import { app } from 'electron';
import { createLogger } from '@urchin/logger';
import type { AppContext } from '../bootstrap/app-context';
import { runCleanupAndExit } from './cleanup';

const log = createLogger('main');

export function installSignalHandlers(ctx: AppContext): void {
  const handle = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (ctx.isCleaningUp) return; // 已有退出流程在跑，忽略重复信号
    log.info(`${signal} received, performing cleanup`);
    runCleanupAndExit(ctx, { exit: (code) => app.exit(code) });
  };

  process.on('SIGINT', () => handle('SIGINT'));
  process.on('SIGTERM', () => handle('SIGTERM'));
}
