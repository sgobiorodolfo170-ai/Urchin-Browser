/**
 * E2E 辅助：获取底部悬浮状态栏页面（独立透明子窗口）。
 *
 * 状态栏已从主窗口 React 移至独立 BrowserWindow（?view=statusbar），
 * 地址栏/导航/功能按钮均在该页面；E2E 需定位此页面操作 Omnibox。
 */
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * 获取当前可操作的地址栏所在页面。
 *
 * 状态栏悬浮层仅在外部网页时创建；内部页（newtab/settings 等）地址栏在主窗口。
 * 导航前若已在外部页则用悬浮层，否则用主窗口（内部页地址栏）。
 */
export async function getOmniboxPage(
  electronApp: ElectronApplication,
  window: Page,
): Promise<Page> {
  const overlay = electronApp.windows().find((p) => p.url().includes('view=statusbar'));
  if (overlay) {
    // 仅当悬浮层可见（外部页）时用其地址栏；内部页悬浮层隐藏，地址栏在主窗口
    const input = overlay.getByLabel('地址栏');
    if (await input.isVisible().catch(() => false)) {
      return overlay;
    }
  }
  return window;
}

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
