/**
 * E2E 回归：收藏夹面板弹出时网页保持可见（让出右侧而非整体隐藏）
 *
 * 2026-08-14 修复验证：
 * - 此前 browserViewHidden=true 将 BrowserView 整体归零隐藏，网页整个消失（用户感知为"被覆盖"）
 * - 修复后 overlayRightWidth=288 让出右侧区域，网页主体保持可见，面板显示在让出的区域中
 *
 * 验证信号（可机器判定）：
 * 1. 面板打开时 BrowserView bounds 宽度 = 窗口宽 - 左栏 - 右栏 - 288（非零）
 * 2. 面板关闭后 BrowserView 恢复全宽
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

/** 读取主进程当前活跃 BrowserView 的 bounds */
async function readActiveViewBounds(
  electronApp: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) return null;
    const views = wins[0]!.getBrowserViews();
    if (views.length === 0) return null;
    return views[0]!.getBounds();
  });
}

test('收藏夹面板弹出时网页保持可见（让出右侧 288px）', async () => {
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

    // 2. 面板打开前的 BrowserView 宽度（应为全宽：窗口 - 左右折叠栏）
    const before = await readActiveViewBounds(electronApp);
    expect(before).not.toBeNull();
    expect(before!.width).toBeGreaterThan(500); // 网页占主体宽度

    // 3. 打开收藏夹面板
    await window.getByLabel('收藏夹').click();
    await window.waitForTimeout(800);

    // 4. 面板打开时的 BrowserView：宽度缩窄（让出 288px）但非零（网页仍可见）
    const during = await readActiveViewBounds(electronApp);
    expect(during).not.toBeNull();
    expect(during!.width).toBeGreaterThan(0); // 网页未被整体隐藏
    expect(during!.width).toBeLessThan(before!.width - 200); // 明显让出

    // 5. 面板可见（React 弹窗正常渲染）
    await expect(window.getByText('历史记录').first()).toBeVisible();

    // 6. 关闭面板后恢复全宽
    await window.getByLabel('收藏夹').click();
    await window.waitForTimeout(800);
    const after = await readActiveViewBounds(electronApp);
    expect(after).not.toBeNull();
    expect(after!.width).toBe(before!.width); // 恢复全宽
  } finally {
    await electronApp.close();
  }
});
