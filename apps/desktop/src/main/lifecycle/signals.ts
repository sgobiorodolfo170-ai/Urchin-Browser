/**
 * 信号处理：Ctrl+C (SIGINT) 和 kill 命令 (SIGTERM)。
 * 转发到统一异步清理流程，完成后再 app.exit()。
 * 注意：Electron 主进程默认不处理 SIGINT/SIGTERM，需显式注册。
 * （refactor-plan-p2 §1.3 步骤 6，自 index.ts 原样迁出；index 在原位置调用
 * installSignalHandlers(ctx)，注册时机与原顶层注册一致。）
 */
import { app } from 'electron';
import { createLogger } from '@urchin/logger';
import type { AppContext } from '../bootstrap/app-context';
import { performCleanup } from './cleanup';

const log = createLogger('main');

export function installSignalHandlers(ctx: AppContext): void {
  process.on('SIGINT', () => {
    log.info('SIGINT received, performing cleanup');
    void performCleanup(ctx).then(() => app.exit(0));
  });

  process.on('SIGTERM', () => {
    log.info('SIGTERM received, performing cleanup');
    void performCleanup(ctx).then(() => app.exit(0));
  });
}
