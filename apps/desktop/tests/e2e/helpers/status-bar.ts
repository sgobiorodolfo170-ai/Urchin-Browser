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
 * 主窗口不再渲染 Omnibox。
 *
 * 状态栏悬浮窗是懒创建的（首次 ui.statusbar.sync 且主窗口可见后才 open，
 * 见 main/status-bar/status-bar-overlay.ts applyVisibility），因此「主窗口
 * React 已挂载」与「悬浮层地址栏可操作」之间存在数百毫秒级时序差：
 * 单次检查命中不了就回退主窗口，会让 fill 在没有地址栏的窗口上等满超时
 * ——这正是 2026-11-05 CI E2E 四个用例（launch/tab-order/translate/
 * workspaces）locator.fill 30s 超时的根因（CI 慢机器稳定输掉该竞态，
 * 本地快机器通常碰巧赢）。此处改为带 deadline 的就绪轮询：悬浮层
 * 地址栏 visible 即返回；超时则抛出携带全部窗口清单的诊断错误，
 * 不静默回退到主窗口。
 */
export async function getOmniboxPage(
  electronApp: ElectronApplication,
  mainWindow: Page,
  timeout = 15_000,
): Promise<Page> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const overlay = electronApp.windows().find((p) => isStatusBarUrl(p.url()));
    if (overlay) {
      const input = overlay.getByRole('textbox', { name: '地址栏' });
      if (await input.isVisible().catch(() => false)) {
        return overlay;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // 超时未就绪：收集全部窗口的 OS 几何与 DOM 视口信息，一次性给出可归因证据
  // （2026-11-06 dev.153 CI 出现「input 已解析但 DOM 不可见」形态，需窗口级
  //  几何数据才能判定是悬浮窗零宽还是其他渲染问题）。
  const snapshot = await electronApp
    .evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        title: w.getTitle(),
        visible: w.isVisible(),
        minimized: w.isMinimized(),
        bounds: w.getBounds(),
      })),
    )
    .catch(() => 'electronApp.evaluate failed');
  const pages = await Promise.all(
    electronApp.windows().map(async (w) => {
      const input = w.getByRole('textbox', { name: '地址栏' });
      const count = await input.count().catch(() => -1);
      const box =
        count > 0
          ? await input
              .first()
              .boundingBox()
              .catch(() => null)
          : null;
      const viewport = await w
        .evaluate(() => ({ innerW: window.innerWidth, innerH: window.innerHeight }))
        .catch(() => null);
      const card = await w
        .evaluate(() => document.querySelector('.status-bar-card')?.outerHTML.slice(0, 400) ?? null)
        .catch(() => null);
      const view = (() => {
        try {
          return new URL(w.url()).searchParams.get('view') ?? 'main';
        } catch {
          return 'unknown';
        }
      })();
      return `${view}: input×${count} box=${JSON.stringify(box)} viewport=${JSON.stringify(viewport)} card=${JSON.stringify(card)}`;
    }),
  );
  // 悬浮页失败截图落 test-results/（随 CI artifact 上传），透明窗口内容可能不完整，
  // 但能直接看到卡片是否渲染。
  const overlayPage = electronApp.windows().find((p) => isStatusBarUrl(p.url()));
  if (overlayPage) {
    await overlayPage
      .screenshot({ path: 'test-results/omnibox-diag-failure.png', fullPage: true })
      .catch(() => undefined);
  }
  throw new Error(
    `状态栏悬浮层地址栏 ${timeout}ms 内未就绪（懒创建未完成、悬浮层零尺寸或渲染失败）。\n` +
      `主窗口 URL: ${mainWindow.url()}\n` +
      `OS 窗口: ${JSON.stringify(snapshot)}\n` +
      `页面: \n  ${pages.join('\n  ')}`,
  );
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
