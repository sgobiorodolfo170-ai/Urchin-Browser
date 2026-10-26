/**
 * E2E 辅助：获取底部悬浮状态栏页面（独立透明子窗口）。
 *
 * 状态栏已从主窗口 React 移至独立 BrowserWindow（?view=statusbar），
 * 地址栏/导航/功能按钮均在该页面；E2E 需定位此页面操作 Omnibox。
 */
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * 判定是否为「状态栏」窗口。
 *
 * ⚠ 不能用 `url.includes('view=statusbar')`：悬浮球的 URL 是
 * `?view=statusbar-ball`，同样命中该子串，而 `windows().find()` 会先拿到球窗口
 * （里面没有地址栏），导致回退到主窗口后超时——这是 2026-10-27 CI E2E
 * 「导航到 URL / 关闭标签」等用例失败的根因。此处按查询参数精确比对。
 */
export function isStatusBarUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get('view') === 'statusbar';
  } catch {
    return false;
  }
}

/**
 * 获取当前可操作的地址栏所在页面。
 *
 * 地址栏只存在于状态栏窗口（dev.120 起底部地址栏改为悬浮子窗口），
 * 主窗口不再渲染 Omnibox；因此本函数只负责在状态栏窗口就绪前等待，
 * 找不到时返回主窗口并让调用方以超时暴露问题（不再静默回退）。
 */
export async function getOmniboxPage(
  electronApp: ElectronApplication,
  window: Page,
): Promise<Page> {
  const overlay = electronApp.windows().find((p) => isStatusBarUrl(p.url()));
  if (overlay) {
    const input = overlay.getByRole('textbox', { name: '地址栏' });
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
  const find = (): Page | undefined => electronApp.windows().find((p) => isStatusBarUrl(p.url()));
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
