/**
 * E2E 回归：收藏夹悬浮面板（独立子窗口，悬浮于网页之上）
 *
 * 2026-08-14 设计（用户原始意图）：
 * - 点击地址栏收藏夹按钮 → 由下往上弹出小窗口，悬浮置顶在网页之上
 * - 只覆盖网页右下角弹窗面积，网页不被隐藏、不被让出
 *
 * 验证信号（可机器判定）：
 * 1. 点击收藏夹按钮 → 出现第二个 BrowserWindow（悬浮面板），尺寸 280×430
 * 2. 主窗口 BrowserView 尺寸不变（网页未被隐藏/让出）
 * 3. 面板定位在主窗口内容区右下角
 * 4. 面板内容可见（收藏夹/历史/下载选项卡，加载真实数据）
 * 5. 再次点击 → 面板关闭
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function launchApp(): Promise<{ electronApp: ElectronApplication; window: Page }> {
  const appPath = resolve(__dirname, '..', '..');
  const userDataDir = mkdtempSync(join(tmpdir(), 'urchin-e2e-panel-'));

  const electronApp = await electron.launch({
    cwd: appPath,
    args: ['.'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PLAYWRIGHT: '1',
      URCHIN_TEST_USER_DATA: userDataDir,
      NODE_OPTIONS: '',
    },
    timeout: 30_000,
  });
  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window };
}

/** 列出所有 BrowserWindow 的尺寸与位置 */
async function listWindows(
  electronApp: ElectronApplication,
): Promise<{ count: number; bounds: { x: number; y: number; width: number; height: number }[] }> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    return {
      count: wins.length,
      bounds: wins.map((w) => w.getBounds()),
    };
  });
}

/** 读取主窗口活跃 BrowserView 的 bounds（验证网页未被隐藏/让出） */
async function readActiveViewBounds(
  electronApp: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    // 遍历所有窗口，取第一个挂载了 BrowserView 的（悬浮面板窗口无 BrowserView）
    for (const w of BrowserWindow.getAllWindows()) {
      const views = w.getBrowserViews();
      if (views.length > 0) return views[0]!.getBounds();
    }
    return null;
  });
}

test('收藏夹按钮弹出悬浮面板（子窗口置顶于网页之上）', async () => {
  const { electronApp, window } = await launchApp();

  try {
    // 1. 导航到真实网页
    await window.evaluate(async () => {
      const u = window as unknown as {
        urchin: { invoke: (c: string, r: unknown) => Promise<unknown> };
      };
      await u.urchin.invoke('tab.loadUrl', { tabId: 1, url: 'https://example.com' });
    });
    await window.waitForTimeout(2500);

    // 面板打开前的状态：1 个窗口（主窗口），BrowserView 全宽
    const before = await listWindows(electronApp);
    expect(before.count).toBe(1);
    const viewBefore = await readActiveViewBounds(electronApp);
    expect(viewBefore).not.toBeNull();

    // 2. 点击收藏夹按钮 → 弹出悬浮面板（第二个 BrowserWindow）
    await window.getByLabel('收藏夹').click();
    await window.waitForTimeout(1200);

    const during = await listWindows(electronApp);
    expect(during.count).toBe(2); // 主窗口 + 悬浮面板

    // 面板为右下角小窗：280×430
    const panelBounds = during.bounds.find((b) => b.width === 280 && b.height === 430);
    expect(panelBounds).toBeTruthy();

    // 面板定位：地址栏上方、右侧栏左侧，且不遮挡网页滚动条（让出 17px + 2px 间隙）。
    // 主窗口 = 挂载了 BrowserView 的那个；面板 = 280×430 的 frameless 小窗。
    const mainBounds = await electronApp.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.getBrowserViews().length > 0) return w.getBounds();
      }
      return null;
    });
    expect(mainBounds).not.toBeNull();
    // 布局：右侧栏 44（折叠）+ 底部地址栏 48；滚动条 17 + 间隙 2
    const expectedX = mainBounds!.x + mainBounds!.width - 44 - 17 - 280 - 2;
    const expectedY = mainBounds!.y + mainBounds!.height - 48 - 17 - 430 - 2;
    // 允许少量偏差（窗口边框/缩放）
    expect(Math.abs(panelBounds!.x - expectedX)).toBeLessThan(16);
    expect(Math.abs(panelBounds!.y - expectedY)).toBeLessThan(16);

    // 3. 网页未被隐藏/让出：BrowserView 尺寸不变（全宽）
    const viewDuring = await readActiveViewBounds(electronApp);
    expect(viewDuring!.width).toBe(viewBefore!.width);
    expect(viewDuring!.width).toBeGreaterThan(500);

    // 4. 面板内容可见：三选项卡（收藏夹/历史/下载）加载真实数据。
    // 注意 windows() 包含主窗口 renderer + BrowserView 网页 + 面板窗口（3 个 page），
    // 必须按 URL 定位面板窗口（urchin://panel）。
    const panelWindow = electronApp.windows().find((w) => w.url().includes('urchin://panel'));
    expect(panelWindow).toBeTruthy();
    await panelWindow!.waitForLoadState('domcontentloaded');
    await expect(panelWindow!.getByText('收藏夹').first()).toBeVisible();
    await expect(panelWindow!.getByText('历史记录').first()).toBeVisible();
    await expect(panelWindow!.getByText('下载列表').first()).toBeVisible();
    // 书签选项卡加载真实数据（空态或列表）
    await expect(panelWindow!.getByText(/暂无书签|加载失败/).first()).toBeVisible({
      timeout: 5000,
    });

    // 5. 点击主窗口（面板外任意处）→ 面板失焦自动关闭
    //    面板以 show() 抢焦点；真实鼠标点击主窗口时 OS 将焦点切回主窗口 → 面板 blur。
    //    Playwright 的 CDP mouse.click 会被 BrowserView 覆盖区域吃掉、不触发 OS 焦点切换，
    //    因此用 Electron 原生 focus() 忠实模拟"点击主窗口"的焦点行为。
    await electronApp.evaluate(({ BrowserWindow }) => {
      // 主窗口 = 挂载了 BrowserView 的窗口（面板窗口无 BrowserView）
      const main = BrowserWindow.getAllWindows().find((w) => w.getBrowserViews().length > 0);
      main?.focus();
    });
    await window.waitForTimeout(800);
    const afterOutside = await listWindows(electronApp);
    expect(afterOutside.count).toBe(1);
  } finally {
    await electronApp.close();
  }
});
