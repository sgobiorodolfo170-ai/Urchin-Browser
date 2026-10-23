/**
 * E2E 辅助：获取底部悬浮状态栏页面（独立透明子窗口）。
 *
 * 状态栏已从主窗口 React 移至独立 BrowserWindow（?view=statusbar），
 * 地址栏/导航/功能按钮均在该页面；E2E 需定位此页面操作 Omnibox。
 */
import type { ElectronApplication, Page } from '@playwright/test';

export async function getStatusBarPage(
  electronApp: ElectronApplication,
  timeout = 15_000,
): Promise<Page> {
  const find = (): Page | undefined =>
    electronApp.windows().find((p) => p.url().includes('view=statusbar'));
  const existing = find();
  if (existing) {
    await existing.waitForLoadState('domcontentloaded');
    return existing;
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = find();
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `status bar overlay page not found (windows: ${electronApp
      .windows()
      .map((w) => w.url())
      .join(', ')})`,
  );
}
