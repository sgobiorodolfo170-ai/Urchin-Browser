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
 *
 * ⚠️ 严禁注入 preload（固化教训）：
 * 之前版本曾为 BrowserView 注入 preload 以暴露 urchin API，但在 sandbox:true
 * 环境下加载 preload 脚本会导致 webContents 加载阻塞，表现为"输入网址后网页
 * 无法打开、刷新受阻"。此问题多次复发，现固化为代码约束：
 * - 外部网页（http/https）不需要 urchin API，无需 preload
 * - 设置页（urchin://settings）已改为 React 组件在主窗口渲染，不在 BrowserView 中
 * - 如需在内部页面暴露 urchin API，应通过主窗口 preload 实现，而非 BrowserView
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
      // ⚠️ 不要添加 preload——见文件头部说明
    },
  });
  // 设置背景色，避免加载过程中白屏闪烁（看起来像阻塞）
  // 在 cast 为 BrowserViewLike 之前调用，因为 setBackgroundColor 不在最小接口中
  view.setBackgroundColor('#ffffff');

  return view as unknown as BrowserViewLike;
}
