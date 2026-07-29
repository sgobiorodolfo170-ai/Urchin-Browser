/**
 * M2 Tab Manager · BrowserView 工厂
 *
 * 依据：契约 D §2 / 02-架构设计 §4 安全边界 / M18 Permission/Sandbox
 * 职责：
 * 1. 创建 Electron BrowserView，配置 M18 安全边界
 * 2. 返回符合 BrowserViewLike 接口的实例（结构化类型兼容）
 *
 * 设计理由（agents.md §七.2 + §六 项目特化审查点「进程隔离」）：
 * - TP1 决策：使用 BrowserView 而非 WebContentsView（v0.1 稳定 API）
 * - tab 的 webContents 同样启用 sandbox + contextIsolation，与窗口安全边界一致
 * - tab preload 暂不注入（M14 Page Context Extractor 阶段再引入）
 */
import { BrowserView } from 'electron';
import { createLogger } from '@urchin/logger';
import type { BrowserViewLike } from './types';

const log = createLogger('view-factory');

/**
 * 创建 BrowserView 并配置 M18 安全边界。
 *
 * @returns 符合 BrowserViewLike 接口的 BrowserView 实例
 */
export function createBrowserView(): BrowserViewLike {
  log.info('creating browser view');

  const view = new BrowserView({
    webPreferences: {
      // M18 安全边界：与主窗口一致
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  return view as unknown as BrowserViewLike;
}
