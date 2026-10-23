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
 *
 * ⚠️ 严禁透明背景 + insertCSS 裁剪（2026-08-17 固化教训）：
 * 曾为"网页区左上角大圆角"给 BrowserView 设置透明背景并注入 clip-path，
 * 但透明 BrowserView 是 Windows DWM 合成压力的根源——多次触发
 * LiveKernelEvent 0x1CC（GPU 引擎超时 TDR），导致整个桌面卡死。
 * 此方案已回滚：BrowserView 保持不透明背景（颜色跟随主题，dev.50；
 * 原硬编码白色在深色模式下造成加载白闪 + 缝隙透白），不再做透明合成。
 */
import { BrowserView } from 'electron';
import type { Session } from 'electron';
import { createLogger } from '@urchin/logger';
import { currentThemeBackground } from '../theme';
import type { BrowserViewLike } from './types';

const log = createLogger('view-factory');

/**
 * 创建 BrowserView 并配置 M18 安全边界。
 *
 * @param workspaceId 标签所属工作区（TP7）：默认工作区走默认 session，
 *  自定义工作区使用 persist 分区（Cookie/存储 全隔离）。
 * @param resolveSession 工作区 → Session 解析器（主进程注入，分区幂等配置在解体内完成）
 * @returns 符合 BrowserViewLike 接口的 BrowserView 实例
 */
export function createBrowserView(
  workspaceId: string,
  resolveSession: (workspaceId: string) => Session,
): BrowserViewLike {
  log.info('creating browser view', { workspaceId });

  const view = new BrowserView({
    webPreferences: {
      // M18 安全边界：与主窗口一致
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // TP7 工作区 session：Cookie/localStorage/IndexedDB/Service Worker 全隔离
      session: resolveSession(workspaceId),
      // ⚠️ 不要添加 preload——见文件头部说明
    },
  });

  // 不透明背景（颜色跟随主题，dev.50）：避免网页加载时闪烁，同时杜绝透明
  // 合成（DWM 压力 → 桌面卡死）。暗色取 --color-surface 同值——硬编码白
  // 在深色模式下既造成加载白闪，也会从 BrowserView 与 React UI 的几何
  // 缝隙透出白色分割线。切换主题时由 ui.theme.set 处理内刷新已存在 view。
  view.setBackgroundColor(currentThemeBackground());

  return view as unknown as BrowserViewLike;
}
