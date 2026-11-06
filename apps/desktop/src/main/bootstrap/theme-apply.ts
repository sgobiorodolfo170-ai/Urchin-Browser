/**
 * 主题应用（refactor-plan-p2 §1.3 步骤 5，自 index.ts 原样迁出）。
 *
 * ui.theme.set handler 与 GenOffice Home 主题切换共用的唯一入口；
 * 迁出后 index.ts ↔ handlers.ts 循环依赖的一条边（applyTheme）消除。
 */
import { nativeTheme } from 'electron';
import { createLogger } from '@urchin/logger';
import { currentThemeBackground } from '../theme';
import type { AppContext } from './app-context';

const log = createLogger('main');

/**
 * 应用主题到原生层与所有视图（ui.theme.set 与 GenOffice Home 共用）。
 *
 * 设置 nativeTheme.themeSource 使窗口标题栏/边框跟随主题；支持
 * prefers-color-scheme 的网页跟随；同步 pi 页直推、窗口/视图背景色，
 * 并向所有 webContents 广播 app:theme-changed（GenOffice 编辑器/Home 消费）。
 */
export function applyTheme(ctx: AppContext, theme: 'light' | 'dark' | 'system'): void {
  nativeTheme.themeSource = theme;
  const bg = currentThemeBackground();
  for (const managed of ctx.windowManager.getAllWindows()) {
    // P2-7：setBackgroundColor? 已入 BrowserWindowLike（可选成员），无需逃逸
    try {
      managed.browserWindow.setBackgroundColor?.(bg);
    } catch {
      /* 测试 mock 无此方法/窗口销毁中：忽略 */
    }
  }
  for (const snapshot of ctx.tabManager.query({})) {
    const tab = ctx.tabManager.getTab(snapshot.id);
    // P2-7：setBackgroundColor? 已入 BrowserViewLike（可选成员），无需逃逸
    try {
      tab?.view.setBackgroundColor?.(bg);
    } catch {
      /* 忽略 */
    }
  }
  log.info('theme set', { theme });
  for (const snapshot of ctx.tabManager.query({})) {
    const tab = ctx.tabManager.getTab(snapshot.id);
    tab?.webContents.send?.('app:theme-changed', theme);
  }
  for (const managed of ctx.windowManager.getAllWindows()) {
    managed.browserWindow.webContents.send('app:theme-changed', theme);
  }
}
